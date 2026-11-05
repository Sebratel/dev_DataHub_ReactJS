// ─────────────────────────────────────────────────────────────────────────
// Conciliação fonte × lake — as REGRAS, sem banco nem rede.
//
// A pergunta que a conciliação responde (D-QLD-3, R4 de 30/10/2026): o número
// no lake é o número da fonte? A resposta só presta se as duas contagens
// olharem para a MESMA população de linhas, e é aqui que isso se decide:
//
//   • o limite de cima é o watermark da última carga (menos a folga, que a
//     próxima carga ainda relê). Uma linha criada depois disso está na fonte e
//     ainda não no lake — e isso não é defeito, é o próximo ciclo;
//   • o limite de baixo é o piso da carga, quando há: o que é mais antigo não
//     vem para o lake POR REGRA. E, no conjunto grande, a janela dos últimos N
//     dias, para não varrer o histórico de uma tabela de 15,9 milhões;
//   • quando a chave é de data, a comparação é POR DIA. É o que transforma
//     "faltam 20 linhas" em "faltam 20 linhas no dia 14/09" — e um dia que não
//     bate aponta direto para a causa (ex.: lote com o mesmo carimbo na
//     fronteira da carga, QLD-01).
//
// Separado do resto para ser testado sem fonte nenhuma (dev/qualitySmoke.ts).
// ─────────────────────────────────────────────────────────────────────────
import type { ReconcileBand, ReconcileDay } from '@datahub/shared'

export interface PlanField { key: string; sourceColumn: string; type: string }

export interface PlanDataset {
  kind: string
  /** 'postgres' | 'mysql' | 'http' | … — null se a conexão sumiu. */
  connectorKind: string | null
  syncMode: string
  incrementalKey: string | null
  incrementalKey2: string | null
  dedupeKeys: string[]
  watermark: string | null
  watermarkLagMinutes: number
  syncSince: string | null
  syncSinceDays: number | null
  lastFullReloadAt: Date | null
  rowCount: number | null
  fields: PlanField[]
}

export interface PlanRules { smallMaxRows: number; largeMinRows: number; largeWindowDays: number }

export interface PlanColumn { key: string; column: string }

export type Plan =
  | { ok: false; reason: string }
  | {
    ok: true
    band: ReconcileBand
    method: 'per-day' | 'total'
    /** Chave que separa por dia (per-day) ou limita o total (incremental numérico). */
    keyField: (PlanColumn & { isDate: boolean }) | null
    sumField: PlanColumn | null
    /** Limite de baixo (inclusivo). null = sem limite. */
    lower: string | null
    /** O piso relativo de uma carga anterior à marca de recarga: o limite de
     *  baixo sai do próprio lake (menor valor da chave). */
    lowerFromLake: boolean
    /** Limite de cima (inclusivo). null = sem limite (snapshot). */
    upper: string | null
    /** Colunas cujo vazio, juntas, deixam a linha fora do lake para sempre. */
    lostCheck: PlanColumn[] | null
    notes: string[]
  }

const SQL_KINDS = new Set(['postgres', 'mysql'])
// Data abaixo disto não é data: é o "0000-00-00" do MySQL, que no lake vira
// vazio. Fica fora dos DOIS lados, senão todo conjunto com esse lixo na fonte
// acusaria uma diferença que não é perda de linha.
export const MENOR_DATA = '1900-01-01 00:00:00.000'

export function bandOf(rowCount: number | null, r: PlanRules): ReconcileBand {
  const n = Number(rowCount ?? 0)
  if (n <= r.smallMaxRows) return 'small'
  if (n >= r.largeMinRows) return 'large'
  return 'medium'
}

/** Mesmo formato do ingest: 'AAAA-MM-DD HH:MM:SS.mmm' em hora LOCAL. */
export function timestampLocal(d: Date): string {
  const p = (n: number, casas = 2) => String(n).padStart(casas, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * Lê um carimbo da fonte como hora LOCAL. Aceita 'AAAA-MM-DD', com hora e
 * fração, com espaço ou 'T' — e IGNORA um sufixo de fuso ('-03', 'Z').
 *
 * Ignorar o fuso é deliberado, não descuido: a sessão da fonte já está no fuso
 * local (pools.ts), então o texto antes do sufixo É a hora local; e o lake faz
 * igual ao converter (Apêndice A.2 da v0.4). Já `new Date('AAAA-MM-DD')`
 * leria meia-noite em UTC — 21 h do dia anterior aqui — e cortaria um dia
 * inteiro da comparação.
 */
export function parseLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?/.exec(String(s).trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', se = '0', frac = '0'] = m
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +se, Math.floor(Number(`0.${frac}`) * 1000))
  return Number.isNaN(t.getTime()) ? null : t
}

function inicioDoDia(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// O maior de dois limites de baixo. As datas estão todas no formato
// 'AAAA-MM-DD…', então a ordem do texto é a ordem do tempo.
function maior(a: string | null, b: string | null): string | null {
  if (a == null) return b
  if (b == null) return a
  return a >= b ? a : b
}

/** Por que um conjunto fica fora da conciliação — null se pode entrar. */
export function ineligibleReason(d: Pick<PlanDataset, 'kind' | 'connectorKind' | 'syncMode' | 'fields' | 'incrementalKey'>): string | null {
  if (d.kind === 'derived') return 'Conjunto calculado: não lê de fonte. A conferência é a dos conjuntos que ele usa.'
  if (d.syncMode === 'live') return 'Modo ao vivo: não há cópia no lake para conferir.'
  if (!d.connectorKind) return 'A conexão deste conjunto não existe mais.'
  if (!SQL_KINDS.has(d.connectorKind)) {
    return `Fonte ${d.connectorKind}: a conciliação compara por SQL e vale só para Postgres e MySQL/MariaDB.`
  }
  if (!d.fields.length) return 'Sem campos publicados.'
  if (d.syncMode === 'incremental' && d.incrementalKey) {
    const f = d.fields.find((x) => x.key === d.incrementalKey)
    if (f && f.type !== 'date' && f.type !== 'number') {
      return 'Chave incremental de texto: a ordem do texto muda entre a fonte e o lake, e não dá ' +
        'para delimitar as duas contagens no mesmo ponto.'
    }
  }
  return null
}

// O que somar. Só campo que NÃO muda depois de criado: somar um valor editável
// acusaria diferença em toda edição feita entre a carga e a conferência — e,
// num conjunto que só acrescenta, em toda edição da história. A identidade
// numérica serve de soma de controle: se uma linha some ou dobra, a soma muda.
function campoDeSoma(d: PlanDataset): PlanColumn | null {
  const num = (k: string | null | undefined) => {
    const f = k ? d.fields.find((x) => x.key === k) : undefined
    return f && f.type === 'number' ? { key: f.key, column: f.sourceColumn } : null
  }
  for (const k of d.dedupeKeys) { const c = num(k); if (c) return c }
  const id = d.fields.find((x) => x.type === 'number' && x.key.toLowerCase() === 'id')
  if (id) return { key: id.key, column: id.sourceColumn }
  return num(d.incrementalKey)
}

export function planReconcile(d: PlanDataset, r: PlanRules, now: Date = new Date()): Plan {
  const motivo = ineligibleReason(d)
  if (motivo) return { ok: false, reason: motivo }

  const band = bandOf(d.rowCount, r)
  const sumField = campoDeSoma(d)
  const notes: string[] = []
  if (!sumField) notes.push('Só contagem: o conjunto não tem identidade numérica para servir de soma de controle.')

  const key1 = d.syncMode === 'incremental' && d.incrementalKey
    ? d.fields.find((x) => x.key === d.incrementalKey) ?? null
    : null

  // Snapshot (ou incremental sem chave, que o ingest trata como snapshot): a
  // carga relê a tabela inteira, então a comparação é a tabela inteira. Sem
  // chave de data, não há como separar por dia.
  if (!key1) {
    notes.push('Snapshot: compara a tabela inteira, sem separar por dia — o conjunto não tem chave de data.')
    return {
      ok: true, band, method: 'total', keyField: null, sumField,
      lower: null, lowerFromLake: false, upper: null, lostCheck: null, notes,
    }
  }

  const isDate = key1.type === 'date'
  const keyField = { key: key1.key, column: key1.sourceColumn, isDate }
  const key2 = d.incrementalKey2 ? d.fields.find((x) => x.key === d.incrementalKey2) ?? null : null
  // Sem as duas chaves, a linha não entra por passada nenhuma: o keyset só
  // avança sobre valores não nulos. Com uma chave só, basta ela estar vazia.
  const lostCheck = [keyField, ...(key2 ? [{ key: key2.key, column: key2.sourceColumn }] : [])]
    .map(({ key, column }) => ({ key, column }))

  // ── Limite de cima: o watermark da carga que acabou de rodar ──────────
  // Sem folga, o próprio texto do watermark: a fonte o compara do jeito que
  // a carga comparou, e o lake o converte do jeito que converteu a coluna.
  let upper = d.watermark
  const lag = Number(d.watermarkLagMinutes || 0)
  if (upper != null && isDate && lag > 0) {
    const t = parseLocal(upper)
    if (t) {
      upper = timestampLocal(new Date(t.getTime() - lag * 60_000))
      notes.push(`Os últimos ${lag} min ficam de fora: é a folga que a próxima carga ainda relê.`)
    }
  }

  if (!isDate) {
    notes.push('Chave incremental numérica: compara o total até o último valor carregado, sem separar por dia.')
    return {
      ok: true, band, method: 'total', keyField, sumField,
      lower: null, lowerFromLake: false, upper, lostCheck, notes,
    }
  }

  // ── Limite de baixo ───────────────────────────────────────────────────
  let lower: string | null = MENOR_DATA
  let lowerFromLake = false
  if (d.syncSince) {
    lower = maior(lower, String(d.syncSince))
    notes.push(`A partir do piso de carga (${String(d.syncSince).slice(0, 10)}): o que é mais antigo não vem para o lake por regra.`)
  } else if (d.syncSinceDays != null) {
    if (d.lastFullReloadAt) {
      // O piso relativo é resolvido no começo da carga completa; a marca de
      // recarga é gravada no FIM dela. Usar a marca põe o limite alguns minutos
      // DEPOIS do piso real — e um limite mais apertado, aplicado igual nos
      // dois lados, nunca acusa diferença que não existe.
      const piso = new Date(d.lastFullReloadAt.getTime() - Number(d.syncSinceDays) * 86_400_000)
      lower = maior(lower, timestampLocal(piso))
    } else {
      lowerFromLake = true
    }
    notes.push(`Piso relativo de ${d.syncSinceDays} dia(s): compara a partir da primeira data que a carga trouxe.`)
  }
  if (band === 'large') {
    const janela = inicioDoDia(new Date(now.getTime() - r.largeWindowDays * 86_400_000))
    lower = maior(lower, timestampLocal(janela))
    notes.push(`Conjunto grande: confere os últimos ${r.largeWindowDays} dias, para não varrer o histórico inteiro na fonte.`)
  }

  return { ok: true, band, method: 'per-day', keyField, sumField, lower, lowerFromLake, upper, lostCheck, notes }
}

// ── SQL ──────────────────────────────────────────────────────────────────
export type Dialect = 'postgres' | 'mysql'

export function quoteFor(dialect: Dialect): (s: string) => string {
  return dialect === 'mysql'
    ? (s: string) => '`' + String(s).replace(/`/g, '') + '`'
    : (s: string) => '"' + String(s).replace(/"/g, '') + '"'
}

type Bounds = { lower: string | null; upper: string | null }

/** Consulta de contagem (e soma) na FONTE. Placeholders do dialeto. */
export function sourceCountSql(
  dialect: Dialect, from: string, plan: { method: 'per-day' | 'total'; keyField: PlanColumn | null; sumField: PlanColumn | null } & Bounds,
): { sql: string; params: string[] } {
  const q = quoteFor(dialect)
  const params: string[] = []
  const ph = () => (dialect === 'mysql' ? '?' : `$${params.length}`)
  const where: string[] = []
  if (plan.keyField) {
    const k = q(plan.keyField.column)
    where.push(`${k} is not null`)
    if (plan.lower != null) { params.push(plan.lower); where.push(`${k} >= ${ph()}`) }
    if (plan.upper != null) { params.push(plan.upper); where.push(`${k} <= ${ph()}`) }
  }
  const s = plan.sumField ? `, sum(${q(plan.sumField.column)}) as s` : ''
  const w = where.length ? ` where ${where.join(' and ')}` : ''
  if (plan.method === 'per-day' && plan.keyField) {
    return { sql: `select cast(${q(plan.keyField.column)} as date) as d, count(*) as n${s} from ${from}${w} group by 1`, params }
  }
  return { sql: `select count(*) as n${s} from ${from}${w}`, params }
}

/** Linhas que a carga nunca traz: todas as chaves incrementais vazias. */
export function sourceLostSql(dialect: Dialect, from: string, lost: PlanColumn[]): string {
  const q = quoteFor(dialect)
  return `select count(*) as n from ${from} where ${lost.map((c) => `${q(c.column)} is null`).join(' and ')}`
}

const sqlit = (s: string) => `'${String(s).replace(/'/g, "''")}'`
const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`

/** A mesma contagem no LAKE (DuckDB), pelos nomes expostos (key). */
export function lakeCountSql(
  glob: string, plan: { method: 'per-day' | 'total'; keyField: (PlanColumn & { isDate: boolean }) | null; sumField: PlanColumn | null } & Bounds,
): string {
  const src = `read_parquet(${sqlit(glob)})`
  const where: string[] = []
  if (plan.keyField) {
    const k = ident(plan.keyField.key)
    const lit = (v: string) => (plan.keyField!.isDate ? `cast(${sqlit(v)} as timestamp)` : `cast(${sqlit(v)} as double)`)
    where.push(`${k} is not null`)
    if (plan.lower != null) where.push(`${k} >= ${lit(plan.lower)}`)
    if (plan.upper != null) where.push(`${k} <= ${lit(plan.upper)}`)
  }
  const s = plan.sumField ? `, sum(${ident(plan.sumField.key)}) as s` : ''
  const w = where.length ? ` where ${where.join(' and ')}` : ''
  if (plan.method === 'per-day' && plan.keyField) {
    return `select cast(${ident(plan.keyField.key)} as date) as d, count(*) as n${s} from ${src}${w} group by 1`
  }
  return `select count(*) as n${s} from ${src}${w}`
}

// ── Comparação ───────────────────────────────────────────────────────────
export interface Bucket { day: string; n: number; s: number | null }

/** Linha devolvida por um driver → balde. Data vira 'AAAA-MM-DD'; número, Number. */
export function toBucket(row: Record<string, unknown>): Bucket {
  const d = row.d == null ? '' : String(row.d instanceof Date ? timestampLocal(row.d) : row.d).slice(0, 10)
  const s = row.s == null ? null : Number(row.s)
  return { day: d, n: Number(row.n ?? 0), s: s != null && Number.isFinite(s) ? s : null }
}

// Soma igual? A fonte soma em inteiro/decimal exato; o lake, em DOUBLE.
//
// Inteiro até 2^53 o DOUBLE representa EXATO, e a comparação tem de ser exata:
// a soma das identidades é uma soma de controle, e uma linha trocada (id 100
// no lugar do 101) muda a soma em 1. Uma tolerância relativa "pequena" como
// 1e-9 engoliria essa diferença numa soma de 10^11 — foi o que o smoke pegou.
// Só acima de 2^53 o DOUBLE arredonda, e aí a tolerância absorve o
// arredondamento (relativo 1e-12, muito abaixo do peso de uma linha).
export function sameSum(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return (a ?? 0) === 0 && (b ?? 0) === 0
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a === b
  return Math.abs(a - b) <= Math.max(1e-12 * Math.max(Math.abs(a), Math.abs(b)), 1e-6)
}

export interface Comparison {
  sourceRows: number
  lakeRows: number
  sourceSum: number | null
  lakeSum: number | null
  daysCompared: number
  diverged: ReconcileDay[]
}

export function compareBuckets(source: Bucket[], lake: Bucket[], withSum: boolean): Comparison {
  const map = new Map<string, { s?: Bucket; l?: Bucket }>()
  for (const b of source) map.set(b.day, { ...(map.get(b.day) ?? {}), s: b })
  for (const b of lake) map.set(b.day, { ...(map.get(b.day) ?? {}), l: b })
  const diverged: ReconcileDay[] = []
  for (const [day, { s, l }] of map) {
    const sn = s?.n ?? 0
    const ln = l?.n ?? 0
    const ss = withSum ? s?.s ?? null : null
    const ls = withSum ? l?.s ?? null : null
    if (sn !== ln || (withSum && !sameSum(ss, ls))) {
      diverged.push({ day, sourceRows: sn, lakeRows: ln, sourceSum: ss, lakeSum: ls })
    }
  }
  diverged.sort((a, b) => (a.day < b.day ? 1 : -1))
  const soma = (bs: Bucket[]) => (withSum ? bs.reduce((t, b) => t + (b.s ?? 0), 0) : null)
  return {
    sourceRows: source.reduce((t, b) => t + b.n, 0),
    lakeRows: lake.reduce((t, b) => t + b.n, 0),
    sourceSum: soma(source),
    lakeSum: soma(lake),
    daysCompared: map.size,
    diverged,
  }
}

/** Bateu? Mesma contagem, mesma soma, nenhum dia diferente, nenhuma linha perdida. */
export function isMatch(c: Comparison, lostRows: number): boolean {
  return c.sourceRows === c.lakeRows && sameSum(c.sourceSum, c.lakeSum) && c.diverged.length === 0 && lostRows === 0
}
