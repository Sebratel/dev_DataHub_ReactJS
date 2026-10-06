// Smoke da consulta agregada pela API pública (POST /public/v1/datasets/:slug/query)
// — o compilador com o DuckDB de verdade, sobre um Parquet de dados inventados.
// Roda sem banco: a rota só soma escopo de token e catálogo ao que é testado
// aqui, e essas duas partes são as mesmas do /rows.
//
// Por que existe: as extensões do QueryDef que a rota abriu (agrupar por
// período, contar linhas, `orNull`, total de grupos) viram SQL montado à mão.
// Um formato de data errado ou um nulo tratado do jeito errado não dá erro em
// lugar nenhum — só devolve um número plausível e errado no painel de quem
// consome a API.
//
// Uso: npm run public-query:smoke --workspace apps/api
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryDef } from '@datahub/shared'
import { compileQuery, type CompileField } from '../modules/query/compile.js'
import { duckQuery } from '../modules/query/duck.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'dh-public-query-'))
const glob = join(dir, '*.parquet').replace(/\\/g, '/')
await duckQuery(`copy (select * from (values
    (1, timestamp '2026-01-15 10:00:00', '2026-01-15',          'Concluído',    'A', 10.0, timestamp '1990-05-01 00:00:00'),
    (2, timestamp '2026-01-31 23:59:00', '2026-01-31 23:59:00', 'Cancelado',    'B', 20.0, timestamp '1985-01-01 00:00:00'),
    (3, timestamp '2026-02-01 00:00:00', '2026-02-01',          null,           'A', null, null),
    (4, timestamp '2026-04-10 08:00:00', 'não é data',          'Concluído',    'C', 5.0,  null),
    (5, timestamp '2025-12-31 12:00:00', '2025-12-31',          'Em andamento', 'B', 7.0,  null),
    (6, null,                            null,                  'Concluído',    null, 3.0, null)
  ) t(id, aberto_em, aberto_txt, status, cliente, valor, nascimento))
  to '${join(dir, 'part-0.parquet').replace(/\\/g, '/')}' (format parquet)`)

const fields: CompileField[] = [
  { key: 'id', type: 'number', sensitive: false },
  { key: 'aberto_em', type: 'date', sensitive: false },
  { key: 'aberto_txt', type: 'text', sensitive: false },
  { key: 'status', type: 'text', sensitive: false },
  { key: 'cliente', type: 'text', sensitive: false },
  { key: 'valor', type: 'number', sensitive: false },
  { key: 'nascimento', type: 'date', sensitive: true },
]

// Exatamente o que a rota faz: compila como NÃO-admin e roda o total se houver.
async function run(def: Omit<QueryDef, 'dataset'>) {
  const c = compileQuery({ dataset: 'smoke', ...def }, fields, { admin: false, glob })
  const { rows } = await duckQuery(c.sql, c.params)
  const total = c.countSql ? Number((await duckQuery(c.countSql, c.countParams)).rows[0]?.n ?? 0) : undefined
  return { rows, total }
}
// Mapa grupo → contagem (null vira '∅'), para comparar sem depender de ordem.
// Ordem por código de caractere, não localeCompare: assim '∅' fica por último.
const byKey = (rows: Record<string, unknown>[], key: string, value = 'n') =>
  JSON.stringify(Object.fromEntries(rows
    .map((r) => [r[key] == null ? '∅' : String(r[key]), Number(r[value])] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
async function fails(def: Omit<QueryDef, 'dataset'>): Promise<string> {
  try { await run(def); return '' } catch (e) { return (e as Error).message }
}

console.log('\n── agrupar por período (campo de data) ──')
const porMes = await run({ select: [{ field: 'aberto_em', grain: 'month', as: 'mes' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_em', grain: 'month' }] })
check('mês sai como início do período, sem deslocar fuso (31/01 23:59 fica em janeiro)',
  byKey(porMes.rows, 'mes') === '{"2025-12-01":1,"2026-01-01":2,"2026-02-01":1,"2026-04-01":1,"∅":1}', byKey(porMes.rows, 'mes'))
const porTrim = await run({ select: [{ field: 'aberto_em', grain: 'quarter', as: 'tri' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_em', grain: 'quarter' }] })
check('trimestre', byKey(porTrim.rows, 'tri') === '{"2025-10-01":1,"2026-01-01":3,"2026-04-01":1,"∅":1}', byKey(porTrim.rows, 'tri'))
const porAno = await run({ select: [{ field: 'aberto_em', grain: 'year', as: 'ano' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_em', grain: 'year' }] })
check('ano', byKey(porAno.rows, 'ano') === '{"2025-01-01":1,"2026-01-01":4,"∅":1}', byKey(porAno.rows, 'ano'))
const porDia = await run({ select: [{ field: 'aberto_em', grain: 'day', as: 'dia' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_em', grain: 'day' }], filters: [{ field: 'id', op: '=', value: 2 }] })
check('dia', byKey(porDia.rows, 'dia') === '{"2026-01-31":1}', byKey(porDia.rows, 'dia'))

console.log('\n── agrupar por período (campo de texto com data) ──')
const porMesTxt = await run({ select: [{ field: 'aberto_txt', grain: 'month', as: 'mes' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_txt', grain: 'month' }] })
check('texto ilegível vira grupo vazio em vez de derrubar a consulta',
  byKey(porMesTxt.rows, 'mes') === '{"2025-12-01":1,"2026-01-01":2,"2026-02-01":1,"∅":2}', byKey(porMesTxt.rows, 'mes'))
check('ordenar pelo alias do período (desc) e cortar no limit',
  JSON.stringify((await run({ select: [{ field: 'aberto_em', grain: 'month', as: 'mes' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'aberto_em', grain: 'month' }], filters: [{ field: 'aberto_em', op: 'not_null' }], orderBy: [{ field: 'mes', dir: 'desc' }], limit: 2 })).rows.map((r) => r.mes))
    === '["2026-04-01","2026-02-01"]')

console.log('\n── contagens ──')
const contagens = (await run({ select: [{ agg: 'count', as: 'linhas' }, { field: 'valor', agg: 'count', as: 'com_valor' }, { field: 'cliente', agg: 'count_distinct', as: 'clientes' }, { field: 'valor', agg: 'sum', as: 'soma' }] })).rows[0]
check('count sem campo conta LINHAS (inclusive as com campos nulos)', Number(contagens.linhas) === 6, String(contagens.linhas))
check('count de um campo segue contando só os não-nulos', Number(contagens.com_valor) === 5, String(contagens.com_valor))
check('count_distinct e sum seguem iguais', Number(contagens.clientes) === 3 && Number(contagens.soma) === 45)

console.log('\n── orNull ──')
const semNulos = await run({ select: [{ agg: 'count', as: 'n' }], filters: [{ field: 'status', op: 'not_in', value: ['Cancelado'] }] })
const comNulos = await run({ select: [{ agg: 'count', as: 'n' }], filters: [{ field: 'status', op: 'not_in', value: ['Cancelado'], orNull: true }] })
check('not_in sem orNull descarta o status vazio (SQL puro, comportamento de antes)', Number(semNulos.rows[0].n) === 4)
check('not_in com orNull mantém o status vazio', Number(comNulos.rows[0].n) === 5, String(comNulos.rows[0].n))
check('orNull não mexe em is_null',
  Number((await run({ select: [{ agg: 'count', as: 'n' }], filters: [{ field: 'status', op: 'is_null', orNull: true }] })).rows[0].n) === 1)

console.log('\n── total de grupos ──')
const grupos = await run({ select: ['status', { agg: 'count', as: 'n' }], groupBy: ['status'], withTotal: true, limit: 2 })
check('withTotal conta os GRUPOS (o vazio é um grupo), não as linhas da página', grupos.total === 4 && grupos.rows.length === 2, `total=${grupos.total}`)
check('sem withTotal, consulta agrupada continua sem total',
  (await run({ select: ['status', { agg: 'count', as: 'n' }], groupBy: ['status'] })).total === undefined)
check('sem groupBy o total de linhas continua vindo',
  (await run({ select: ['id'], filters: [{ field: 'status', op: '=', value: 'Concluído' }], limit: 1 })).total === 3)

console.log('\n── travas ──')
check('período de data SENSÍVEL é bloqueado para não-admin',
  /sensível/.test(await fails({ select: [{ field: 'nascimento', grain: 'year', as: 'a' }, { agg: 'count', as: 'n' }], groupBy: [{ field: 'nascimento', grain: 'year' }] })))
check('granularidade fora da lista é recusada antes de virar SQL',
  /Granularidade de data inválida/.test(await fails({ select: [{ field: 'aberto_em', grain: "month') --" as never, as: 'x' }], groupBy: [{ field: 'aberto_em', grain: "month') --" as never }] })))
check('período só vale para data/texto (número é recusado com mensagem clara)',
  /só vale para campo de data/.test(await fails({ select: [{ field: 'valor', grain: 'month', as: 'x' }], groupBy: [{ field: 'valor', grain: 'month' }] })))
check('sem campo, só a contagem é aceita',
  /única agregação possível/.test(await fails({ select: [{ agg: 'sum' } as never] })))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
