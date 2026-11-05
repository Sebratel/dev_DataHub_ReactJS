// Smoke das REGRAS da conciliação fonte × lake (D-QLD-3) e do formato dos
// alertas — sem banco, sem fonte, sem rede.
//
// O que pode dar errado aqui não dá erro: dá número. Um limite de baixo um dia
// adiantado, um watermark lido em UTC, um placeholder trocado entre Postgres e
// MySQL — tudo isso faz a conciliação dizer "bate" quando não bate, ou acusar
// diferença que não existe. Por isso cada regra tem um caso com o valor exato.
//
// Uso: npm run quality:smoke --workspace apps/api
import {
  bandOf, ineligibleReason, planReconcile, parseLocal, timestampLocal, MENOR_DATA,
  sourceCountSql, sourceLostSql, lakeCountSql, toBucket, compareBuckets, isMatch, sameSum,
  type PlanDataset, type PlanRules,
} from '../modules/quality/reconcilePlan.js'
import { alertText, validateWebhookUrl, webhookHint } from '../modules/alerts/notify.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`)

const R: PlanRules = { smallMaxRows: 100_000, largeMinRows: 2_000_000, largeWindowDays: 60 }
const base = (o: Partial<PlanDataset> = {}): PlanDataset => ({
  kind: 'source', connectorKind: 'postgres', syncMode: 'incremental',
  incrementalKey: 'criado_em', incrementalKey2: null, dedupeKeys: ['id'],
  watermark: '2026-11-05 10:00:00.123', watermarkLagMinutes: 0,
  syncSince: null, syncSinceDays: null, lastFullReloadAt: null, rowCount: 5_000,
  fields: [
    { key: 'id', sourceColumn: 'id', type: 'number' },
    { key: 'criado_em', sourceColumn: 'dt_criacao', type: 'date' },
    { key: 'alterado_em', sourceColumn: 'dt_alteracao', type: 'date' },
    { key: 'valor', sourceColumn: 'valor', type: 'number' },
    { key: 'codigo', sourceColumn: 'codigo', type: 'text' },
  ],
  ...o,
})
const NOW = new Date(2026, 10, 5, 6, 0, 0) // 05/11/2026 06:00, hora local

console.log('\n── faixas (D-QLD-3) ──')
eq('100 mil é pequeno (cabe em dois lotes)', bandOf(100_000, R), 'small')
eq('100.001 é médio', bandOf(100_001, R), 'medium')
eq('2 milhões é grande', bandOf(2_000_000, R), 'large')
eq('sem contagem conta como pequeno', bandOf(null, R), 'small')

console.log('\n── quem fica de fora ──')
check('calculado fica de fora', !!ineligibleReason({ ...base(), kind: 'derived' }))
check('modo ao vivo fica de fora', !!ineligibleReason({ ...base(), syncMode: 'live' }))
check('fonte HTTP fica de fora', !!ineligibleReason({ ...base(), connectorKind: 'http' }))
check('conexão apagada fica de fora', !!ineligibleReason({ ...base(), connectorKind: null }))
check('chave incremental de texto fica de fora', !!ineligibleReason({ ...base(), incrementalKey: 'codigo' }))
check('MySQL entra', ineligibleReason({ ...base(), connectorKind: 'mysql' }) === null)

console.log('\n── leitura de carimbo em hora LOCAL ──')
eq('data pura é meia-noite LOCAL (não 21 h do dia anterior)',
  timestampLocal(parseLocal('2026-11-05')!), '2026-11-05 00:00:00.000')
eq('sufixo de fuso é ignorado (a sessão já está no fuso local)',
  timestampLocal(parseLocal('2026-10-01 15:10:00-03')!), '2026-10-01 15:10:00.000')
eq('fração de microssegundos vira milissegundos',
  timestampLocal(parseLocal('2026-10-01T15:10:00.123456')!), '2026-10-01 15:10:00.123')
check('texto que não é data devolve null', parseLocal('ontem') === null)

console.log('\n── plano: incremental por data ──')
{
  const p = planReconcile(base(), R, NOW)
  check('separa por dia', p.ok && p.method === 'per-day')
  if (p.ok) {
    eq('sem folga, o limite de cima é o próprio watermark', p.upper, '2026-11-05 10:00:00.123')
    eq('limite de baixo descarta datas inválidas (0000-00-00)', p.lower, MENOR_DATA)
    eq('soma de controle pela identidade numérica', p.sumField, { key: 'id', column: 'id' })
    eq('com uma chave só, a linha some quando ela está vazia', p.lostCheck, [{ key: 'criado_em', column: 'dt_criacao' }])
  }
}
{
  const p = planReconcile(base({ watermarkLagMinutes: 10, incrementalKey2: 'alterado_em' }), R, NOW)
  if (p.ok) {
    eq('a folga sai do limite de cima', p.upper, '2026-11-05 09:50:00.123')
    eq('com duas chaves, a linha só some com as DUAS vazias', p.lostCheck,
      [{ key: 'criado_em', column: 'dt_criacao' }, { key: 'alterado_em', column: 'dt_alteracao' }])
  } else check('plano com folga', false, p.reason)
}
{
  const p = planReconcile(base({ watermark: '2026-11-05', watermarkLagMinutes: 30 }), R, NOW)
  eq('watermark de DATE com folga: meia-noite local menos a folga', p.ok && p.upper, '2026-11-04 23:30:00.000')
}
{
  const p = planReconcile(base({ rowCount: 15_900_000 }), R, NOW)
  eq('grande: confere só os últimos 60 dias, a partir do início do dia', p.ok && p.lower, '2026-09-06 00:00:00.000')
  eq('grande continua por dia', p.ok && p.method, 'per-day')
}
{
  const p = planReconcile(base({ syncSince: '2025-01-01' }), R, NOW)
  eq('piso fixo vira o limite de baixo', p.ok && p.lower, '2025-01-01')
}
{
  const p = planReconcile(base({ syncSince: '2025-01-01', rowCount: 15_900_000 }), R, NOW)
  eq('no grande, vale o MAIS RECENTE entre piso e janela', p.ok && p.lower, '2026-09-06 00:00:00.000')
}
{
  const reload = new Date(2026, 9, 31, 4, 0, 0)
  const p = planReconcile(base({ syncSinceDays: 3, lastFullReloadAt: reload }), R, NOW)
  eq('piso relativo: marca da recarga menos N dias', p.ok && p.lower, '2026-10-28 04:00:00.000')
  const p2 = planReconcile(base({ syncSinceDays: 3 }), R, NOW)
  check('piso relativo sem marca de recarga: limite sai do lake', p2.ok && p2.lowerFromLake)
}

console.log('\n── plano: snapshot e chave numérica ──')
{
  const p = planReconcile(base({ syncMode: 'snapshot', incrementalKey: null }), R, NOW)
  check('snapshot compara o total, sem limites', p.ok && p.method === 'total' && p.upper === null && p.lower === null && p.keyField === null)
  check('snapshot não procura linha perdida (não há keyset)', p.ok && p.lostCheck === null)
}
{
  const p = planReconcile(base({ incrementalKey: 'id', watermark: '98765' }), R, NOW)
  check('chave numérica compara o total até o watermark', p.ok && p.method === 'total' && p.upper === '98765')
}
{
  const p = planReconcile(base({
    dedupeKeys: ['codigo'],
    fields: [{ key: 'criado_em', sourceColumn: 'criado_em', type: 'date' }, { key: 'valor', sourceColumn: 'valor', type: 'number' }],
  }), R, NOW)
  check('sem identidade numérica: só contagem (valor editável não serve de soma)', p.ok && p.sumField === null)
  check('e a nota explica por quê', p.ok && p.notes.some((n) => n.startsWith('Só contagem')))
}

console.log('\n── SQL ──')
{
  const plan = { method: 'per-day' as const, keyField: { key: 'criado_em', column: 'dt_criacao' }, sumField: { key: 'id', column: 'id' }, lower: 'L', upper: 'U' }
  const pg = sourceCountSql('postgres', '"erp"."pedidos"', plan)
  eq('Postgres: placeholders numerados', pg.sql,
    'select cast("dt_criacao" as date) as d, count(*) as n, sum("id") as s from "erp"."pedidos" where "dt_criacao" is not null and "dt_criacao" >= $1 and "dt_criacao" <= $2 group by 1')
  eq('Postgres: parâmetros na ordem', pg.params, ['L', 'U'])
  const my = sourceCountSql('mysql', '`erp`.`pedidos`', plan)
  check('MySQL: crase e "?"', my.sql.includes('`dt_criacao` >= ?') && my.sql.includes('`dt_criacao` <= ?') && !my.sql.includes('$'))
  const tot = sourceCountSql('postgres', 't', { method: 'total', keyField: null, sumField: null, lower: null, upper: null })
  eq('snapshot sem soma: só count(*)', tot.sql, 'select count(*) as n from t')
  eq('linha perdida: todas as chaves vazias',
    sourceLostSql('postgres', 't', [{ key: 'a', column: 'a' }, { key: 'b', column: 'b' }]),
    'select count(*) as n from t where "a" is null and "b" is null')
  const lk = lakeCountSql('/lake/x/*.parquet', { ...plan, keyField: { ...plan.keyField, key: 'criado_em', isDate: true }, lower: "2026-01-01 00:00:00.000", upper: "it's" })
  check('lake: usa o nome exposto (key), não a coluna física', lk.includes('"criado_em"') && !lk.includes('dt_criacao'))
  check('lake: limites convertidos para TIMESTAMP', lk.includes("cast('2026-01-01 00:00:00.000' as timestamp)"))
  check('lake: aspas do limite escapadas', lk.includes("'it''s'"))
}

console.log('\n── comparação ──')
{
  const f = [{ day: '2026-09-13', n: 10, s: 55 }, { day: '2026-09-14', n: 45, s: 2000 }]
  const l = [{ day: '2026-09-13', n: 10, s: 55 }, { day: '2026-09-14', n: 25, s: 1100 }]
  const c = compareBuckets(f, l, true)
  eq('o dia do empate na fronteira do lote aparece sozinho (QLD-01)', c.diverged.map((d) => d.day), ['2026-09-14'])
  eq('totais somam os dias', [c.sourceRows, c.lakeRows], [55, 35])
  check('não bate', !isMatch(c, 0))
  const igual = compareBuckets(f, f, true)
  check('dias iguais batem', isMatch(igual, 0) && igual.daysCompared === 2)
  check('linha perdida (chave vazia) impede o "bate" mesmo com dias iguais', !isMatch(igual, 3))
  const soSoma = compareBuckets([{ day: 'x', n: 1, s: 10 }], [{ day: 'x', n: 1, s: 11 }], true)
  check('mesma contagem com soma diferente diverge (linha trocada)', soSoma.diverged.length === 1)
  const dia = compareBuckets([{ day: '2026-10-01', n: 3, s: null }], [], false)
  eq('dia que só existe na fonte entra com zero no lake', dia.diverged[0], { day: '2026-10-01', sourceRows: 3, lakeRows: 0, sourceSum: null, lakeSum: null })
}
check('soma: inteiros iguais batem', sameSum(123456789012, 123456789012))
check('soma: um a mais não bate', !sameSum(123456789012, 123456789013))
check('soma: arredondamento de DOUBLE em valor enorme é tolerado', sameSum(9.007199254740993e18, 9.007199254740992e18))
eq('balde de driver: data em texto e número em texto', toBucket({ d: '2026-09-14', n: '45', s: '2000' }), { day: '2026-09-14', n: 45, s: 2000 })
eq('balde do lake: data com hora vira só o dia', toBucket({ d: '2026-09-14 00:00:00', n: 1, s: null }), { day: '2026-09-14', n: 1, s: null })

console.log('\n── alertas ──')
eq('texto: título em negrito e uma linha por item', alertText('Conciliação divergente: X', ['a', '', 'b']), '*Data Hub · Conciliação divergente: X*\na\nb')
check('webhook https passa', validateWebhookUrl(' https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t ') ===
  'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t')
for (const ruim of ['http://chat.googleapis.com/x', 'ftp://x', 'nada', 'https://u:p@host/x']) {
  let recusou = false
  try { validateWebhookUrl(ruim) } catch { recusou = true }
  check(`webhook recusado: ${ruim}`, recusou)
}
{
  const h = webhookHint('https://chat.googleapis.com/v1/spaces/AAA/messages?key=SEGREDO&token=abcd1234')
  check('a dica mostra o host e os 4 últimos', h === 'chat.googleapis.com …1234', h)
  check('a dica não mostra a chave', !h.includes('SEGREDO'))
}

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
