// Smoke do SEG-01 — SQL livre não pode ler arquivo nenhum além dos conjuntos
// que o usuário alcança. É o roteiro do teste T-SEG-04 do comitê, automatizado.
//
// O defeito: o validador de SQL era uma lista de palavras proibidas que apagava
// o conteúdo entre aspas antes de olhar. O DuckDB lê um arquivo quando o caminho
// aparece entre aspas no FROM — então `select * from '/qualquer/arquivo'`
// passava, num notebook, para qualquer usuário logado. Lia o Parquet de um
// conjunto sem concessão e qualquer arquivo do contêiner.
//
// A correção tem duas camadas, e cada uma é testada aqui SEM a outra:
//   1. o MOTOR (duck.ts) só alcança as pastas do lake e trava a configuração —
//      testado chamando duckQuery direto, por fora do validador;
//   2. o VALIDADOR (compileLakeSql) lê o SQL pela árvore do DuckDB e só aceita
//      conjuntos permitidos — testado com o arquivo DENTRO do lake, onde o motor
//      sozinho deixaria passar.
// E confere o outro lado: SQL legítimo de analista continua funcionando.
//
// Sem banco: os conjuntos são montados à mão como o lakeRefs montaria.
// Uso: npm run sandbox:smoke --workspace apps/api
import { rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duckQuery } from '../modules/query/duck.js'
import { compileLakeSql, type LakeRef } from '../modules/transform/derive.js'
import { parquetGlob } from '../core/lake.js'
import { smokeDir } from './smokeDir.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const fwd = (p: string) => p.replace(/\\/g, '/')

// ── Cenário ──────────────────────────────────────────────────────────────
// Dois conjuntos no lake: um que o usuário alcança e um sem concessão. E um
// "segredo" FORA do lake, no lugar onde um arquivo qualquer do contêiner estaria.
const lake = smokeDir('sandbox-')
const dirPermitido = join(lake, 'contratos-ativos')
const dirRestrito = join(lake, 'folha-pagamento')
mkdirSync(dirPermitido, { recursive: true })
mkdirSync(dirRestrito, { recursive: true })
const fora = mkdtempSync(join(tmpdir(), 'sandbox-fora-'))
const segredo = fwd(join(fora, 'credencial.json'))
writeFileSync(segredo, JSON.stringify({ private_key: 'NAO-PODE-SAIR' }))
const segredoCsv = fwd(join(fora, 'senhas.csv'))
writeFileSync(segredoCsv, 'usuario,senha\nerp,NAO-PODE-SAIR\n')

// O próprio motor escreve os Parquet de teste — dentro do lake, o que também
// prova que a escrita legítima continua funcionando com a trava ligada.
const pqPermitido = fwd(join(dirPermitido, 'part-1.parquet'))
const pqRestrito = fwd(join(dirRestrito, 'part-1.parquet'))
await duckQuery(`copy (select * from (values (1, 'ana', 100.0), (2, 'bia', 250.0)) t(id, cliente, valor)) to '${pqPermitido}' (format parquet)`)
await duckQuery(`copy (select * from (values (1, 'NAO-PODE-SAIR', 99999.0)) t(id, nome, salario)) to '${pqRestrito}' (format parquet)`)

// Só o permitido entra nos refs — é o que lakeRefs devolve para quem não tem
// concessão no outro.
const refs: LakeRef[] = [{ slug: 'contratos-ativos', glob: parquetGlob(dirPermitido) }]

async function tenta(sql: string): Promise<{ ok: boolean; rows?: Record<string, unknown>[]; erro?: string }> {
  try {
    const wrapped = await compileLakeSql(sql, refs)
    const r = await duckQuery(`select * from (${wrapped}) as __t limit 100`)
    return { ok: true, rows: r.rows }
  } catch (e) {
    return { ok: false, erro: (e as Error).message.split('\n')[0].slice(0, 140) }
  }
}

function vazou(r: { rows?: Record<string, unknown>[] }): boolean {
  return JSON.stringify(r.rows ?? []).includes('NAO-PODE-SAIR')
}

async function recusa(nome: string, sql: string): Promise<void> {
  const r = await tenta(sql)
  check(nome, !r.ok && !vazou(r), r.ok ? `EXECUTOU: ${JSON.stringify(r.rows).slice(0, 120)}` : r.erro)
}

async function aceita(nome: string, sql: string, esperado?: (rows: Record<string, unknown>[]) => boolean): Promise<void> {
  const r = await tenta(sql)
  check(nome, r.ok && (!esperado || esperado(r.rows!)), r.ok ? `${r.rows!.length} linha(s)` : r.erro)
}

try {
  // ── Camada 1: o motor, atacado por fora do validador ─────────────────────
  console.log('\n── motor: nada fora do lake, e a trava não se desfaz ──')
  for (const [nome, sql] of [
    ['caminho entre aspas fora do lake', `select * from '${segredoCsv}'`],
    ['read_json de arquivo fora do lake', `select * from read_json('${segredo}')`],
    ['read_text de arquivo fora do lake', `select * from read_text('${segredo}')`],
    ['/proc/self/environ (senhas da stack)', `select * from read_text('/proc/self/environ')`],
    ['escrever fora do lake', `copy (select 1) to '${fwd(join(fora, 'x.parquet'))}' (format parquet)`],
  ] as const) {
    let erro = ''
    try { await duckQuery(sql) } catch (e) { erro = (e as Error).message }
    check(nome, /Permission Error|disabled by configuration/i.test(erro), erro.split('\n')[0].slice(0, 110) || 'EXECUTOU')
  }
  for (const sql of [`set enable_external_access = true`, `set allowed_directories = ['/']`, `reset enable_external_access`]) {
    let erro = ''
    try { await duckQuery(sql) } catch (e) { erro = (e as Error).message }
    check(`não desfaz a trava: ${sql}`, /locked/i.test(erro), erro.split('\n')[0].slice(0, 110) || 'ACEITOU')
  }

  // ── Camada 2: o validador, com o alvo DENTRO do lake ─────────────────────
  // Aqui o motor deixaria passar (é pasta permitida). Quem segura é a árvore.
  console.log('\n── validador: só os conjuntos que o usuário alcança ──')
  await recusa('conjunto sem concessão pelo nome', `select * from folha_pagamento`)
  await recusa('conjunto sem concessão pelo slug entre aspas', `select * from "folha-pagamento"`)
  await recusa('Parquet sem concessão pelo caminho entre aspas (Apêndice A)', `select * from '${pqRestrito}'`)
  await recusa('Parquet sem concessão pelo caminho com aspas duplas', `select * from "${pqRestrito}"`)
  await recusa('glob da pasta do lake', `select * from '${fwd(lake)}/*/*.parquet'`)
  await recusa('arquivo fora do lake pelo caminho', `select * from '${segredoCsv}'`)
  await recusa('metadados do Parquet (Apêndice A)', `select * from parquet_metadata('${pqRestrito}')`)
  await recusa('parquet_schema', `select * from parquet_schema('${pqRestrito}')`)
  await recusa('read_parquet explícito', `select * from read_parquet('${pqRestrito}')`)
  await recusa('query_table contorna o nome', `select * from query_table('folha_pagamento')`)
  await recusa('query() com SQL dentro de string', `select * from query('select * from ''${pqRestrito}''')`)
  await recusa('caminho dentro de subconsulta escalar', `select (select max(salario) from '${pqRestrito}') as s`)
  await recusa('caminho dentro de EXISTS', `select * from contratos_ativos where exists (select 1 from '${pqRestrito}')`)
  await recusa('caminho num JOIN', `select * from contratos_ativos c join '${pqRestrito}' f on f.id = c.id`)
  await recusa('caminho num UNION', `select nome from '${pqRestrito}' union all select cliente from contratos_ativos`)
  await recusa('CTE com nome de arquivo usada fora do escopo',
    `select * from (with "${pqRestrito}" as (select 1 as id) select * from "${pqRestrito}") a, "${pqRestrito}" b`)
  await recusa('catálogo do sistema (schema.tabela)', `select * from information_schema.tables`)
  await recusa('função de catálogo do motor', `select * from duckdb_settings()`)
  await recusa('dois comandos', `select 1; select * from '${pqRestrito}'`)
  await recusa('escrita disfarçada', `copy (select 1) to 'x.parquet'`)
  await recusa('attach de outro banco', `attach '${fwd(join(fora, 'x.db'))}' as x`)

  // ── O outro lado: o que o analista faz no dia a dia continua valendo ─────
  console.log('\n── SQL legítimo continua funcionando ──')
  await aceita('conjunto permitido pelo apelido', `select count(*) as n from contratos_ativos`,
    (r) => Number(r[0]?.n) === 2)
  await aceita('conjunto permitido pelo slug entre aspas', `select sum(valor) as t from "contratos-ativos"`,
    (r) => Number(r[0]?.t) === 350)
  await aceita('maiúsculas no nome', `SELECT * FROM Contratos_Ativos`)
  await aceita('CTE própria + janela', `with c as (select * from contratos_ativos)
    select cliente, row_number() over (order by valor desc) as pos from c`, (r) => r.length === 2)
  await aceita('subconsulta, EXISTS e UNION entre permitidos', `select cliente from contratos_ativos c
    where exists (select 1 from contratos_ativos x where x.id = c.id)
    union all select 'extra'`, (r) => r.length === 3)
  await aceita('range() e unnest() geram linhas sem ler nada', `select r.range as i, u.v from range(3) r, unnest([10, 20]) u(v)`,
    (r) => r.length === 6)
  await aceita('literal com caminho no SELECT não é leitura', `select '${pqRestrito}' as texto from contratos_ativos`,
    (r) => r.length === 2)
  await aceita('ponto-e-vírgula no fim', `select 1 as um from contratos_ativos;`)
} finally {
  rmSync(lake, { recursive: true, force: true })
  rmSync(fora, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} falha(s).` : '\nTudo certo.')
process.exit(failures ? 1 : 0)
