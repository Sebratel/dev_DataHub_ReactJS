// Smoke da publicação no Databricks. Roda SEM banco, SEM rede e SEM workspace:
// valida as quatro coisas que não dá para conferir lendo o código —
//   1. a normalização de nomes de coluna (acento, espaço, camelCase, colisão);
//   2. a CONSOLIDAÇÃO sobre Parquet de verdade: partes com a mesma chave
//      colapsam na versão mais recente, pela regra da compactação;
//   3. o FUSO: o lake guarda hora local sem fuso, e o que sai tem de ser o
//      instante certo em UTC — inclusive numa data com horário de verão;
//   4. a classificação de erro e o backoff: o que repete, o que não repete.
// Uso: npm run databricks:smoke --workspace apps/api
import { randomUUID } from 'node:crypto'
import { duckQuery } from '../modules/query/duck.js'
import { datasetDir, removeDatasetDir } from '../core/lake.js'
import {
  toSnakeCase, mapColumnNames, precisaConverterFuso, consolidar,
} from '../modules/databricks/consolidate.js'
import { deveRepetir, comRetentativa, DatabricksError } from '../modules/databricks/client.js'
import { montarManifesto, sha256Arquivo } from '../modules/databricks/manifest.js'
import { camadaDe, slugDeTabela } from '../modules/databricks/publish.js'
import { join } from 'node:path'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 1. Nomes de coluna ───────────────────────────────────────────────────
console.log('\n1. Normalização de nomes de coluna')
check('acento e espaço', toSnakeCase('Data Atualização') === 'data_atualizacao',
  toSnakeCase('Data Atualização'))
check('camelCase', toSnakeCase('createdAt') === 'created_at', toSnakeCase('createdAt'))
check('símbolos viram separador', toSnakeCase('valor (R$)') === 'valor_r', toSnakeCase('valor (R$)'))
check('começa com dígito ganha prefixo', toSnakeCase('2024_total') === 'col_2024_total',
  toSnakeCase('2024_total'))
{
  const m = mapColumnNames(['Data Nasc', 'data_nasc'])
  check('colisão na normalização é resolvida',
    m.get('Data Nasc') === 'data_nasc' && m.get('data_nasc') === 'data_nasc_2',
    `${m.get('Data Nasc')} / ${m.get('data_nasc')}`)
}
check('TIMESTAMP sem fuso converte', precisaConverterFuso('TIMESTAMP'))
check('TIMESTAMPTZ não converte', !precisaConverterFuso('TIMESTAMP WITH TIME ZONE'))
check('DATE não converte', !precisaConverterFuso('DATE'))

// ── 2 e 3. Consolidação e fuso, sobre Parquet de verdade ─────────────────
console.log('\n2. Consolidação (dedup) e 3. conversão de fuso')
const TENANT = 'sebratel'
const SLUG = '_smoke-databricks'
const dir = datasetDir(TENANT, SLUG).replace(/\\/g, '/')

// Três partes, como o incremental deixa o lake antes de compactar: a chave 1
// aparece em duas, com versões diferentes. A linha de 2018 cai no horário de
// verão brasileiro, que existiu até 2019 — é o caso que uma conversão com
// deslocamento fixo de -03 erraria.
const parte = (n: number, linhas: string) => duckQuery(
  `copy (${linhas}) to '${dir}/part-${n}.parquet' (format parquet, compression zstd)`)

await parte(1, `select 1::BIGINT as id, 'antigo' as nome,
  timestamp '2026-10-05 08:00:00' as "Data Atualização", date '2026-10-05' as dia`)
await parte(2, `select 1::BIGINT as id, 'novo' as nome,
  timestamp '2026-10-05 09:00:00' as "Data Atualização", date '2026-10-05' as dia`)
await parte(3, `select 2::BIGINT as id, 'verao' as nome,
  timestamp '2018-01-15 08:00:00' as "Data Atualização", date '2018-01-15' as dia`)

const runId = randomUUID()
const cons = await consolidar({
  tenantSlug: TENANT, slug: SLUG,
  dedupeKeys: ['id'],
  recencyKeys: [{ key: 'Data Atualização', isDate: true }],
  runId, hhmm: '0800',
})

check('leu as 3 partes', cons.sourceParts === 3, String(cons.sourceParts))
check('consolidou em 1 arquivo', cons.files.length === 1, String(cons.files.length))
check('dedup: 2 identidades distintas', cons.rowCount === 2, String(cons.rowCount))
check('coluna renomeada vai no manifesto',
  cons.renamed.some((r) => r.from === 'Data Atualização' && r.to === 'data_atualizacao'))

const lido = await duckQuery(
  `select id, nome, dia::VARCHAR as dia,
          strftime(data_atualizacao AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') as utc
     from read_parquet('${cons.files[0].replace(/\\/g, '/')}') order by id`)
const r1 = lido.rows[0] as Record<string, string>
const r2 = lido.rows[1] as Record<string, string>

check('venceu a versão mais recente', r1.nome === 'novo', String(r1.nome))
check('09:00 em São Paulo vira 12:00Z', r1.utc === '2026-10-05T12:00:00Z', String(r1.utc))
check('08:00 de jan/2018 (horário de verão) vira 10:00Z',
  r2.utc === '2018-01-15T10:00:00Z', String(r2.utc))
check('DATE não é deslocada', r1.dia === '2026-10-05' && r2.dia === '2018-01-15',
  `${r1.dia} / ${r2.dia}`)

const tipos = await duckQuery(
  `describe select * from read_parquet('${cons.files[0].replace(/\\/g, '/')}')`)
const tipoDe = new Map(tipos.rows.map((r) => [String(r.column_name), String(r.column_type)]))
check('timestamp sai com fuso UTC no Parquet',
  String(tipoDe.get('data_atualizacao')).toUpperCase().includes('WITH TIME ZONE'),
  String(tipoDe.get('data_atualizacao')))
check('DATE continua DATE', tipoDe.get('dia') === 'DATE', String(tipoDe.get('dia')))

// ── 4. Manifesto e hash ──────────────────────────────────────────────────
console.log('\n4. Manifesto e hash')
const manifesto = await montarManifesto({
  runId, slug: SLUG, layer: 'bronze', sourceConnection: 'API_WebDeveloper',
  mode: 'SNAPSHOT', dedupeKeys: ['id'], sourceParts: cons.sourceParts,
  rowCount: cons.rowCount, columns: cons.columns, renamed: cons.renamed,
  sourceTimezone: 'America/Sao_Paulo',
  arquivos: [{ local: cons.files[0], volume: `/Volumes/x/y/bronze/${SLUG}/dt=2026-10-05/0800_${runId}.parquet` }],
  extractedAt: new Date('2026-10-05T11:00:12Z'),
})
check('row_count é o do consolidado', manifesto.row_count === 2, String(manifesto.row_count))
check('compressão declarada é zstd', manifesto.compression === 'zstd')
check('fuso declarado', manifesto.timestamps.stored_as === 'UTC'
  && manifesto.timestamps.source_timezone === 'America/Sao_Paulo')
check('sha256 tem 64 hex', /^[0-9a-f]{64}$/.test(manifesto.files[0].sha256))
check('tamanho confere', manifesto.files[0].size_bytes > 0)
check('extracted_at em UTC', manifesto.extracted_at === '2026-10-05T11:00:12.000Z')
{
  const alvo = join(tmpdir(), `sha-${runId}.txt`)
  writeFileSync(alvo, 'abc')
  const h = await sha256Arquivo(alvo)
  // SHA-256 de "abc", valor público e estável.
  check('sha256 bate com o valor conhecido',
    h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', h)
  rmSync(alvo, { force: true })
}

// ── 5. Camada e nome de tabela ───────────────────────────────────────────
console.log('\n5. Camada e nome de tabela')
check('fonte sem camada definida é bronze', camadaDe('source', null) === 'bronze')
check('calculado sem camada definida é prata', camadaDe('derived', null) === 'prata')
check('camada explícita vence', camadaDe('derived', 'ouro') === 'ouro')
check('hífen vira underscore na tabela', slugDeTabela('db-matrix') === 'db_matrix')

// ── 6. Erros: o que repete e o que não ───────────────────────────────────
console.log('\n6. Classificação de erro e backoff')
check('401 não repete', !deveRepetir(401))
check('403 não repete', !deveRepetir(403))
check('404 não repete', !deveRepetir(404))
check('400 não repete', !deveRepetir(400))
check('429 repete', deveRepetir(429))
check('503 repete', deveRepetir(503))
check('falha de rede (sem status) repete', deveRepetir(null))

{
  let chamadas = 0
  try {
    await comRetentativa(async () => {
      chamadas++
      throw new DatabricksError('HTTP 401', 401, false)
    })
    check('401 para na primeira tentativa', false, 'não lançou')
  } catch {
    check('401 para na primeira tentativa', chamadas === 1, `${chamadas} chamada(s)`)
  }
}
{
  let chamadas = 0
  const t0 = Date.now()
  const r = await comRetentativa(async () => {
    chamadas++
    if (chamadas < 2) throw new DatabricksError('HTTP 503', 503, true)
    return 'ok'
  })
  const esperou = Date.now() - t0
  check('503 repete e sucede', r.valor === 'ok' && r.attempts === 2, `${r.attempts} tentativa(s)`)
  check('backoff esperou ~1s antes da 2ª', esperou >= 900, `${esperou} ms`)
}

// ── 7. A migration e o UPDATE do router, no Postgres de verdade ──────────
// Em pglite (Postgres embarcado): sem Docker, sem servidor, mas com o MESMO
// motor. É o que prova que a migration aplica e que as constraints recusam o
// que deveriam — e, principalmente, que o UPDATE com parâmetro nulo não morre
// na inferência de tipo ("could not determine data type of parameter"), que é
// um erro que só aparece em execução.
console.log('\n7. Migration e UPDATE em Postgres (pglite)')
{
  const pg = new PGlite()
  await pg.exec(`
    create table tenants (id uuid primary key default gen_random_uuid(), slug text not null);
    create table datasets (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid references tenants(id),
      slug text not null,
      kind text not null default 'source',
      updated_at timestamptz not null default now()
    );
  `)
  const migration = readFileSync(
    join(import.meta.dirname, '../db/migrations/034-databricks-publish.sql'), 'utf8')
  let aplicou = true
  let erroMigration = ''
  try { await pg.exec(migration) } catch (e) { aplicou = false; erroMigration = (e as Error).message }
  check('a migration 034 aplica', aplicou, erroMigration)

  const dsId = (await pg.query<{ id: string }>(
    `insert into datasets (slug) values ('db-matrix') returning id`)).rows[0].id

  check('nasce desligada', (await pg.query<{ databricks_enabled: boolean }>(
    `select databricks_enabled from datasets where id = $1`, [dsId],
  )).rows[0].databricks_enabled === false)

  // O UPDATE EXATAMENTE como está no databricksRouter.
  const UPDATE = `
    update datasets set
      databricks_enabled = coalesce($2, databricks_enabled),
      databricks_mode = coalesce($3, databricks_mode),
      databricks_layer = case when $4 = '' then null else coalesce($4, databricks_layer) end,
      updated_at = now()
    where id = $1 returning databricks_enabled, databricks_mode, databricks_layer`

  {
    const r = (await pg.query<Record<string, unknown>>(UPDATE, [dsId, true, 'SNAPSHOT', 'ouro'])).rows[0]
    check('liga, com modo e camada', r.databricks_enabled === true && r.databricks_layer === 'ouro')
  }
  {
    // Só o modo: os outros campos vêm nulos e não podem ser zerados.
    const r = (await pg.query<Record<string, unknown>>(UPDATE, [dsId, null, null, null])).rows[0]
    check('parâmetro nulo não apaga o que já estava',
      r.databricks_enabled === true && r.databricks_layer === 'ouro')
  }
  {
    const r = (await pg.query<Record<string, unknown>>(UPDATE, [dsId, null, null, ''])).rows[0]
    check('string vazia volta a camada para o padrão', r.databricks_layer === null)
  }

  let recusou = false
  try { await pg.query(`update datasets set databricks_mode = 'TALVEZ' where id = $1`, [dsId]) }
  catch { recusou = true }
  check('modo inválido é recusado pela constraint', recusou)

  recusou = false
  try { await pg.query(`update datasets set databricks_layer = 'platina' where id = $1`, [dsId]) }
  catch { recusou = true }
  check('camada inválida é recusada pela constraint', recusou)

  recusou = false
  try {
    await pg.query(
      `insert into databricks_sync_runs (id, dataset_slug, status, mode)
       values (gen_random_uuid(), 'x', 'QUASE', 'SNAPSHOT')`)
  } catch { recusou = true }
  check('status inválido no log é recusado', recusou)

  await pg.query(
    `insert into databricks_sync_runs (id, dataset_id, dataset_slug, status, mode, row_count)
     values (gen_random_uuid(), $1, 'db-matrix', 'SUCCESS', 'SNAPSHOT', 594302)`, [dsId])
  check('o log aceita um envio bem-sucedido',
    (await pg.query<{ n: number }>(`select count(*)::int as n from databricks_sync_runs`)).rows[0].n === 1)

  // O histórico precisa sobreviver ao conjunto: o slug é o nome da pasta no
  // volume, e alguém ainda vai querer saber para onde aqueles arquivos foram.
  await pg.query(`delete from datasets where id = $1`, [dsId])
  const sobrou = (await pg.query<{ n: number; dataset_id: string | null }>(
    `select count(*)::int as n, max(dataset_id::text) as dataset_id from databricks_sync_runs`)).rows[0]
  check('excluir o conjunto preserva o histórico de envios',
    sobrou.n === 1 && sobrou.dataset_id === null)
  await pg.close()
}

removeDatasetDir(TENANT, SLUG)
console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo.')
process.exit(failures ? 1 : 0)
