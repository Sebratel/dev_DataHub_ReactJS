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
  sourceCountSql, sourceLostSql, lakeCountSql, lakeDupSql, diagnose, toBucket, compareBuckets, isMatch, sameSum,
  type PlanDataset, type PlanRules, type DiagnosisInput,
} from '../modules/quality/reconcilePlan.js'
import { alertText, validateWebhookUrl, webhookHint } from '../modules/alerts/notify.js'
import { staleVerdict, volumeVerdict, idade, type StaleInput } from '../modules/quality/checkRules.js'
import { sourceDupIdentitySql } from '../modules/quality/reconcilePlan.js'

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

console.log('\n── identidade na fonte (QLD-04) ──')
{
  const p = planReconcile(base({ dedupeKeys: ['id', 'codigo'] }), R, NOW)
  eq('incremental com identidade: confere as colunas da identidade', p.ok && p.identity,
    [{ key: 'id', column: 'id' }, { key: 'codigo', column: 'codigo' }])
  const sem = planReconcile(base({ dedupeKeys: [] }), R, NOW)
  check('sem identidade configurada, nada a conferir', sem.ok && sem.identity === null)
  const sumiu = planReconcile(base({ dedupeKeys: ['id', 'coluna_que_sumiu'] }), R, NOW)
  check('identidade com campo que sumiu do catálogo não é conferida pela metade', sumiu.ok && sumiu.identity === null)
  const snap = planReconcile(base({ syncMode: 'snapshot', incrementalKey: null }), R, NOW)
  check('snapshot não compacta: a identidade não decide nada lá', snap.ok && snap.identity === null)

  const lim = { keyField: { key: 'criado_em', column: 'dt' }, lower: 'L', upper: 'U' }
  const pg2 = sourceDupIdentitySql('postgres', 't', lim, [{ key: 'a', column: 'a' }, { key: 'b', column: 'b' }])
  eq('Postgres: distinct de várias colunas compara a linha (a, b)', pg2.sql,
    'select count(*) - count(distinct ("a", "b")) as dup from t where "dt" is not null and "dt" >= $1 and "dt" <= $2 and "a" is not null and "b" is not null')
  eq('Postgres: mesmos limites da contagem', pg2.params, ['L', 'U'])
  const my2 = sourceDupIdentitySql('mysql', 't', lim, [{ key: 'a', column: 'a' }, { key: 'b', column: 'b' }])
  check('MySQL: distinct com a lista direto', my2.sql.includes('count(distinct `a`, `b`)'), my2.sql)
  const um = sourceDupIdentitySql('postgres', 't', { keyField: null, lower: null, upper: null }, [{ key: 'id', column: 'id' }])
  eq('uma coluna só: distinct simples', um.sql, 'select count(*) - count(distinct "id") as dup from t where "id" is not null')
  const igual = compareBuckets([{ day: 'x', n: 5, s: 15 }], [{ day: 'x', n: 5, s: 15 }], true)
  check('identidade repetida na fonte impede o "bate" mesmo com contagem igual', !isMatch(igual, 0, 2) && isMatch(igual, 0, 0))
}

console.log('\n── prazo pela cadência (MON-09, QLD-10) ──')
{
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000)
  const st = (o: Partial<StaleInput>): StaleInput => ({
    kind: 'source', syncMode: 'incremental', cadence: 'hourly', paused: false,
    lastSyncAt: at(30), schedule: null, inputs: [], ...o,
  })
  const late = (v: ReturnType<typeof staleVerdict>) => (v.evaluate ? v.late : 'não avalia')
  eq('de hora em hora, parado há 3 h: atrasado (o selo antigo dizia "em dia" até 26 h)', late(staleVerdict(st({ lastSyncAt: at(180) }), NOW)), true)
  eq('de hora em hora, há 90 min: em dia', late(staleVerdict(st({ lastSyncAt: at(90) }), NOW)), false)
  eq('diária há 25 h: em dia', late(staleVerdict(st({ cadence: 'daily', lastSyncAt: at(25 * 60) }), NOW)), false)
  eq('diária há 27 h: atrasada', late(staleVerdict(st({ cadence: 'daily', lastSyncAt: at(27 * 60) }), NOW)), true)
  eq('manual não promete prazo', late(staleVerdict(st({ cadence: 'manual', lastSyncAt: at(9999) }), NOW)), 'não avalia')
  eq('pausado tem alerta próprio', late(staleVerdict(st({ paused: true, lastSyncAt: at(9999) }), NOW)), 'não avalia')
  eq('ao vivo não tem carga', late(staleVerdict(st({ syncMode: 'live' }), NOW)), 'não avalia')

  // Agendamento seg–sex 05:00–18:00 de 5 em 5 min; NOW = qui 05/11 06:00.
  const sched = { intervalMinutes: 5, startTime: '05:00', endTime: '18:00', weekdays: 62 }
  eq('agendamento de 5 min parado há 40 min dentro da janela: atrasado (limite 30 min)',
    late(staleVerdict(st({ cadence: 'schedule', schedule: sched, lastSyncAt: at(40) }), NOW)), true)
  eq('agendamento parado há 20 min: em dia',
    late(staleVerdict(st({ cadence: 'schedule', schedule: sched, lastSyncAt: at(20) }), NOW)), false)
  const fora = staleVerdict(st({ cadence: 'schedule', schedule: { ...sched, startTime: '08:00' }, lastSyncAt: at(9999) }), NOW)
  check('fora da janela não avalia, mas mantém o estado de antes', !fora.evaluate && fora.keep)
  const abriu = staleVerdict(st({ cadence: 'schedule', schedule: { ...sched, startTime: '05:45' }, lastSyncAt: at(9999) }), NOW)
  check('janela que acabou de abrir ainda não cobra', !abriu.evaluate && abriu.keep)

  const calc = (insumoMin: number, calcMin: number) => staleVerdict(st({
    kind: 'derived', syncMode: 'snapshot', cadence: 'cascade', lastSyncAt: at(calcMin),
    inputs: [{ slug: 'pedidos', lastSyncAt: at(insumoMin) }, { slug: 'clientes', lastSyncAt: null }],
  }), NOW)
  eq('calculado em cascata que não acompanha o insumo há 2 h: atrasado', late(calc(10, 130)), true)
  eq('calculado que acompanhou: em dia', late(calc(30, 25)), false)
  const v = calc(10, 130)
  check('o detalhe diz qual insumo andou', v.evaluate && v.detail.includes('pedidos'), v.evaluate ? v.detail : '')
}

console.log('\n── volume do snapshot (QLD-08) ──')
eq('caiu 25%: suspeito', volumeVerdict(10_000, 7_500)?.fail, true)
eq('caiu 10%: normal', volumeVerdict(10_000, 9_000)?.fail, false)
eq('cresceu: normal', volumeVerdict(10_000, 12_000)?.fail, false)
eq('tabela pequena não avalia (10 → 7 linhas não diz nada)', volumeVerdict(500, 100), null)
eq('primeira carga não avalia', volumeVerdict(null, 100), null)
check('o detalhe traz os dois números', !!volumeVerdict(10_000, 7_500)?.detail.includes('10.000'))
eq('idade legível', [idade(45), idade(150), idade(60 * 50)], ['45 min', '2 h 30 min', '2 dias'])

console.log('\n── diagnóstico da divergência ──')
{
  const d = (o: Partial<DiagnosisInput>): string => diagnose({
    syncMode: 'incremental', sourceRows: 100, lakeRows: 100, lakeDup: 0, dupBy: 'id',
    hasIdentity: true, keyField: 'criado_em', ...o,
  })
  check('lake a mais sem repetidas: apagadas na fonte, recarga resolve',
    /apagadas/.test(d({ lakeRows: 455 })) && /recarga completa/.test(d({ lakeRows: 455 })) && d({ lakeRows: 455 }).includes('355'))
  check('lake a mais POR repetidas: diz quantas e por qual chave',
    d({ lakeRows: 110, lakeDup: 10 }).includes('10 linha(s) repetida(s) (mesmo id)'))
  check('repetidas sem identidade: manda definir a identidade (senão volta)',
    /defina a identidade/.test(d({ lakeRows: 110, lakeDup: 10, hasIdentity: false })))
  check('repetidas e apagadas juntas: separa as duas',
    d({ lakeRows: 130, lakeDup: 10 }).includes('sobram 20'))
  check('faltando no lake: cita a chave de carga', /Faltam 5 .*criado_em/.test(d({ lakeRows: 95 })))
  check('mesmo total, dias diferentes: linha alterada', /Mesmo total/.test(d({})))
  check('snapshot: não manda recarregar', !/recarga completa/.test(d({ syncMode: 'snapshot', lakeRows: 455 })))
  check('sem como medir repetidas: avisa', /Não deu para descartar/.test(d({ lakeRows: 455, lakeDup: null, dupBy: null })))
  const sql = lakeDupSql('/lake/x/*.parquet', { keyField: { key: 'criado_em', column: 'dt', isDate: true }, lower: '2026-01-01', upper: null }, ['a', 'b'])
  check('repetidas no lake: mesma janela da contagem', sql.includes("\"criado_em\" >= cast('2026-01-01' as timestamp)"))
  check('repetidas no lake: distinct pelas colunas da chave, sem nulas', sql.includes('select distinct "a", "b"') && sql.includes('"a" is not null and "b" is not null'))
}

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
