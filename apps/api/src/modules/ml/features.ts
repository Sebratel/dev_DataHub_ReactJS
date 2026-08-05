// ─────────────────────────────────────────────────────────────────────────
// Engenharia de atributos: do lake para a matriz numérica.
//
// O trabalho pesado (juntar, filtrar, agregar) é SQL no DuckDB, que já é rápido
// nisso e respeita os limites do motor. Aqui só acontece a CODIFICAÇÃO — o que
// um modelo linear precisa e o SQL não dá de graça.
//
// O `feature_schema` gerado aqui é o CONTRATO do modelo. A predição recodifica
// pela mesma ordem e pelas mesmas categorias; se o schema não bater, a resposta
// seria um número plausível e silenciosamente errado — por isso é validado.
// ─────────────────────────────────────────────────────────────────────────
import { duckQuery } from '../query/duck.js'
import { lakeRefs, buildLakeSql, validateTransformSql } from '../transform/derive.js'
import type { Matrix } from './algorithms.js'

export type FeatureKind = 'numeric' | 'onehot'

export interface FeatureSpec {
  /** Nome final da coluna codificada (o que aparece na importância). */
  name: string
  /** Coluna de origem no resultado do SQL. */
  source: string
  kind: FeatureKind
  /** Categoria representada, quando kind='onehot'. */
  category?: string
  /** Valor usado quando vem nulo, quando kind='numeric' (média do treino). */
  impute?: number
}

export interface FeatureSchema {
  features: FeatureSpec[]
  target: string
  task: 'binary' | 'regression'
  /** Colunas descartadas e o motivo — aparece na tela para não virar mistério. */
  dropped: { column: string; reason: string }[]
}

const MAX_CATEGORIES = 20
// Acima disto a coluna é identificador disfarçado (cpf, id, e-mail): milhares
// de colunas one-hot que só decoram o treino e não generalizam.
const MAX_DISTINCT = 50

// Alvo binário aceita as formas que aparecem de fato nos dados de negócio.
export function toBinary(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v > 0 ? 1 : 0
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 't', 'sim', 's', 'yes', 'y'].includes(s)) return 1
  if (['0', 'false', 'f', 'nao', 'não', 'n', 'no'].includes(s)) return 0
  const n = Number(s)
  return Number.isFinite(n) ? (n > 0 ? 1 : 0) : null
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Roda o SQL de atributos sobre o lake, com o mesmo guard dos derivados
// (somente leitura, sem alcançar o sistema de arquivos) e um teto de linhas.
export async function runFeatureSql(
  tenantSlug: string, sql: string, maxRows: number,
): Promise<Record<string, unknown>[]> {
  validateTransformSql(sql)
  const refs = await lakeRefs(tenantSlug)
  const wrapped = buildLakeSql(sql, refs)
  const res = await duckQuery(`select * from (${wrapped}) as __ml limit ${Math.max(1, Math.floor(maxRows))}`)
  return res.rows
}

interface ColumnProfile {
  numeric: number
  text: number
  nulls: number
  distinct: Set<string>
  sum: number
  count: number
}

// Uma passada pelos dados decide o tipo de cada coluna. Decidir pelo tipo
// declarado no catálogo seria frágil: o SQL de atributos cria colunas novas.
function profile(rows: Record<string, unknown>[], columns: string[]): Map<string, ColumnProfile> {
  const map = new Map<string, ColumnProfile>()
  for (const c of columns) {
    map.set(c, { numeric: 0, text: 0, nulls: 0, distinct: new Set(), sum: 0, count: 0 })
  }
  for (const row of rows) {
    for (const c of columns) {
      const p = map.get(c)!
      const v = row[c]
      if (v === null || v === undefined || v === '') { p.nulls++; continue }
      const n = asNumber(v)
      if (n !== null) { p.numeric++; p.sum += n; p.count++ }
      else {
        p.text++
        if (p.distinct.size <= MAX_DISTINCT + 1) p.distinct.add(String(v))
      }
    }
  }
  return map
}

export function buildSchema(
  rows: Record<string, unknown>[],
  target: string,
  task: 'binary' | 'regression',
  excluded: string[],
): FeatureSchema {
  if (!rows.length) throw new Error('O SQL de atributos não retornou nenhuma linha.')
  const all = Object.keys(rows[0])
  if (!all.includes(target)) {
    throw new Error(`A coluna alvo "${target}" não existe no resultado do SQL. Disponíveis: ${all.join(', ')}.`)
  }

  const skip = new Set([target, ...excluded])
  const candidates = all.filter((c) => !skip.has(c))
  const prof = profile(rows, candidates)
  const features: FeatureSpec[] = []
  const dropped: { column: string; reason: string }[] = []

  for (const col of candidates) {
    const p = prof.get(col)!
    if (p.numeric === 0 && p.text === 0) {
      dropped.push({ column: col, reason: 'só valores nulos' })
      continue
    }
    // Predominantemente numérica → uma coluna, nulos imputados pela média.
    if (p.numeric >= p.text) {
      features.push({
        name: col, source: col, kind: 'numeric',
        impute: p.count ? p.sum / p.count : 0,
      })
      continue
    }
    if (p.distinct.size > MAX_DISTINCT) {
      dropped.push({ column: col, reason: `${p.distinct.size}+ valores distintos (parece identificador)` })
      continue
    }
    // Categórica → one-hot das categorias mais frequentes.
    const counts = new Map<string, number>()
    for (const row of rows) {
      const v = row[col]
      if (v === null || v === undefined || v === '') continue
      const key = String(v)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CATEGORIES)
    if (top.length < 2) {
      dropped.push({ column: col, reason: 'valor constante' })
      continue
    }
    for (const [category] of top) {
      features.push({ name: `${col}=${category}`, source: col, kind: 'onehot', category })
    }
    if (counts.size > top.length) {
      dropped.push({ column: col, reason: `${counts.size - top.length} categoria(s) rara(s) agrupada(s) fora do modelo` })
    }
  }

  if (!features.length) {
    throw new Error('Nenhuma coluna utilizável como atributo — revise o SQL, o alvo e as colunas excluídas.')
  }
  return { features, target, task, dropped }
}

// Codifica UMA linha na ordem exata do schema. Usada no treino e na predição —
// mesma função nos dois, que é o que garante que não divirjam.
export function encodeRow(row: Record<string, unknown>, schema: FeatureSchema): number[] {
  const out = new Array<number>(schema.features.length)
  for (let j = 0; j < schema.features.length; j++) {
    const f = schema.features[j]
    const v = row[f.source]
    if (f.kind === 'numeric') {
      const n = asNumber(v)
      out[j] = n === null ? (f.impute ?? 0) : n
    } else {
      out[j] = v !== null && v !== undefined && String(v) === f.category ? 1 : 0
    }
  }
  return out
}

export interface EncodeResult { matrix: Matrix; skipped: number }

// Monta a matriz. Linha sem alvo válido é DESCARTADA (não imputada): inventar
// alvo é ensinar o modelo a resposta errada.
export function encodeMatrix(rows: Record<string, unknown>[], schema: FeatureSchema): EncodeResult {
  const cols = schema.features.length
  const x = new Float64Array(rows.length * cols)
  const y = new Float64Array(rows.length)
  let n = 0
  let skipped = 0

  for (const row of rows) {
    const rawTarget = row[schema.target]
    const t = schema.task === 'binary' ? toBinary(rawTarget) : asNumber(rawTarget)
    if (t === null) { skipped++; continue }
    const encoded = encodeRow(row, schema)
    x.set(encoded, n * cols)
    y[n] = t
    n++
  }

  if (n < 20) {
    throw new Error(`Só ${n} linha(s) com alvo válido — insuficiente para treinar. Verifique a coluna "${schema.target}".`)
  }
  return {
    matrix: { x: x.subarray(0, n * cols), y: y.subarray(0, n), rows: n, cols },
    skipped,
  }
}
