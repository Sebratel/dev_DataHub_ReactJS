// Fuso horário no caminho fonte → lake, medido com as peças reais.
//
// O defeito que motivou este arquivo tinha DOIS efeitos, e o segundo é o que
// dói: todo horário vindo de fonte Postgres chegava ao lake 3 horas adiantado
// (efeito visível), e o watermark era gravado em UTC e comparado com uma coluna
// `timestamp` que não tem fuso — o Postgres ignora o `Z` nessa comparação, o
// corte parava 3 horas no FUTURO e as linhas criadas nesse intervalo NUNCA
// eram lidas. Sem erro, sem log: só faltava dado.
//
// Aqui o Postgres é de verdade (pglite) e o DuckDB é o mesmo do lake — é a
// única forma de provar o comportamento, porque o problema mora exatamente na
// conversão que cada um faz por conta própria.
//
// Uso: TZ=America/Sao_Paulo npm run tz:smoke --workspace apps/api
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { duckQuery } from '../modules/query/duck.js'
import { timestampLocal, normalizaWatermark } from '../modules/sync/ingest.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone
console.log(`\n── fuso do processo: ${fuso} ──`)

// ── 1. O horário sobrevive da fonte até o Parquet ────────────────────────
console.log('\n── o horário da fonte chega intacto ao lake ──')
const NA_FONTE = '2026-09-28 15:10:35.684'

const pg = new PGlite()
await pg.exec(`create table protocolos (id int, criado timestamp, editado timestamptz)`)
await pg.exec(
  `insert into protocolos values (1, '${NA_FONTE}', '${NA_FONTE}-03'),
                                 (2, '2026-09-28 16:30:00.000', null),
                                 (3, '2026-09-28 17:45:00.000', null),
                                 (4, '2026-09-28 19:00:00.000', null)`,
)

// Como o ingest lê: data como TEXTO (é o que o override de tipos garante).
const lida = (await pg.query<{ criado: unknown }>(
  `select to_char(criado, 'YYYY-MM-DD HH24:MI:SS.MS') as criado from protocolos where id = 1`,
)).rows[0].criado as string
check('a fonte entrega o horário como está na tabela', lida === NA_FONTE, lida)

// E como o lake grava, a partir desse texto.
const dir = mkdtempSync(join(tmpdir(), 'tz-smoke-')).replace(/\\/g, '/')
try {
  await duckQuery(
    `copy (select try_cast('${lida}' as TIMESTAMP) as criado)
       to '${dir}/p.parquet' (format parquet)`,
  )
  const noLake = String((await duckQuery(
    `select strftime(criado, '%Y-%m-%d %H:%M:%S.%g') as c from read_parquet('${dir}/*.parquet')`,
  )).rows[0].c)
  check('o lake grava o mesmo horário da fonte', noLake === NA_FONTE, noLake)

  // O que acontecia antes: Date → toISOString() → UTC, e o DuckDB descarta o Z.
  const comoEraAntes = new Date(2026, 8, 28, 15, 10, 35, 684).toISOString()
  const antes = String((await duckQuery(
    `select strftime(try_cast('${comoEraAntes}' as TIMESTAMP), '%H:%M') as h`,
  )).rows[0].h)
  check('e o formato antigo (UTC) de fato adiantava o horário', antes !== '15:10',
    `'${comoEraAntes}' virava ${antes} no lake`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. O watermark não pode parar no futuro ──────────────────────────────
// É o efeito grave: o corte 3h à frente faz a leitura pular linhas em silêncio.
console.log('\n── o watermark compara certo com a coluna ──')

const ultimaLida = new Date(2026, 8, 28, 15, 10, 35, 684)
const traz = async (mark: string) => (await pg.query<{ id: number }>(
  `select id from protocolos where criado > $1 order by id`, [mark],
)).rows.map((r) => r.id)

const comUtc = await traz(ultimaLida.toISOString())     // como era antes
const comLocal = await traz(timestampLocal(ultimaLida)) // como é agora

check('o formato antigo pulava as linhas das 3 horas seguintes',
  JSON.stringify(comUtc) === '[4]', `trazia ${JSON.stringify(comUtc)}`)
check('o formato local traz TODAS as linhas posteriores',
  JSON.stringify(comLocal) === '[2,3,4]', `traz ${JSON.stringify(comLocal)}`)

// ── 3. Watermark antigo, já gravado, se acerta sozinho ───────────────────
console.log('\n── watermark gravado antes da correção ──')
check('watermark em UTC é reescrito para hora local',
  normalizaWatermark('2026-09-28T18:10:35.684Z') === NA_FONTE,
  String(normalizaWatermark('2026-09-28T18:10:35.684Z')))
check('watermark com deslocamento explícito também',
  normalizaWatermark('2026-09-28T18:10:35.684+00:00') === NA_FONTE,
  String(normalizaWatermark('2026-09-28T18:10:35.684+00:00')))
// O que NÃO pode ser tocado: já está no formato certo, ou nem é data.
check('watermark já local passa intacto',
  normalizaWatermark(NA_FONTE) === NA_FONTE)
check('watermark numérico (chave id) passa intacto',
  normalizaWatermark('8302147') === '8302147')
check('watermark nulo passa intacto', normalizaWatermark(null) === null)

// Depois de normalizado, o conjunto volta a ler o que estava sendo pulado.
const depois = await traz(normalizaWatermark('2026-09-28T18:10:35.684Z')!)
check('normalizado, o conjunto volta a enxergar as linhas puladas',
  JSON.stringify(depois) === '[2,3,4]', `traz ${JSON.stringify(depois)}`)

await pg.close()
console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
