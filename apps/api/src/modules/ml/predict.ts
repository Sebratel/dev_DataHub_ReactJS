// Predição. Recodifica cada linha pelo MESMO schema gravado no treino e aplica
// o artefato. É aqui que o contrato de entrada é cobrado: um modelo pontuado
// com colunas diferentes das que ele viu devolve número plausível e errado —
// falhar alto é melhor que responder bobagem com cara de confiança.
import { db } from '../../db/pool.js'
import { predictLogistic, predictLinear, type LinearModel } from './algorithms.js'
import { encodeRow, runFeatureSql, type FeatureSchema } from './features.js'

export interface PromotedModel {
  modelId: string
  slug: string
  name: string
  task: 'binary' | 'regression'
  version: number
  versionId: string
  schema: FeatureSchema
  artifact: { kind: 'logistic' | 'linear'; model: LinearModel }
  featureSql: string | null
  tenantSlug: string
}

export async function loadPromoted(tenantSlug: string, slug: string): Promise<PromotedModel> {
  const row = (await db.query(
    `select m.id, m.slug, m.name, m.task, m.feature_sql,
            v.id as version_id, v.version, v.artifact, v.feature_schema
       from ml_models m
       join tenants t on t.id = m.tenant_id
       left join ml_model_versions v on v.id = m.promoted_version_id
      where t.slug = $1 and m.slug = $2`,
    [tenantSlug, slug],
  )).rows[0]

  if (!row) throw new Error(`Modelo "${slug}" não encontrado.`)
  if (!row.version_id) throw new Error(`O modelo "${slug}" ainda não tem versão promovida — treine antes de predizer.`)

  return {
    modelId: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    task: row.task as 'binary' | 'regression',
    version: Number(row.version),
    versionId: String(row.version_id),
    schema: row.feature_schema as FeatureSchema,
    artifact: row.artifact as PromotedModel['artifact'],
    featureSql: (row.feature_sql as string | null) ?? null,
    tenantSlug,
  }
}

// Colunas que o schema exige e a linha não tem. Numérica ausente seria imputada
// silenciosamente pela média — e uma predição inteira feita de médias parece
// perfeitamente normal na tela. Por isso conferimos antes.
export function missingColumns(row: Record<string, unknown>, schema: FeatureSchema): string[] {
  const needed = new Set(schema.features.map((f) => f.source))
  return [...needed].filter((c) => !(c in row))
}

export function scoreOne(pm: PromotedModel, row: Record<string, unknown>): number {
  const encoded = encodeRow(row, pm.schema)
  return pm.artifact.kind === 'logistic'
    ? predictLogistic(pm.artifact.model, encoded)
    : predictLinear(pm.artifact.model, encoded)
}

export interface ScoredRow { prediction: number; row: Record<string, unknown> }

export function scoreRows(pm: PromotedModel, rows: Record<string, unknown>[]): ScoredRow[] {
  if (!rows.length) return []
  const missing = missingColumns(rows[0], pm.schema)
  if (missing.length) {
    throw new Error(
      `As linhas enviadas não têm as colunas que o modelo espera: ${missing.slice(0, 8).join(', ')}` +
      `${missing.length > 8 ? ` (+${missing.length - 8})` : ''}.`,
    )
  }
  return rows.map((row) => ({ prediction: scoreOne(pm, row), row }))
}

// Pontuação em lote sobre o próprio SQL de atributos do modelo — o caminho
// normal: "rode o churn na base ativa e me dê os 500 de maior risco".
export interface BatchOptions { limit?: number; minScore?: number; keyColumns?: string[] }

export async function scoreBatch(
  pm: PromotedModel, opts: BatchOptions = {},
): Promise<{ scored: number; rows: Record<string, unknown>[] }> {
  if (!pm.featureSql) throw new Error('Modelo sem SQL de atributos — não há o que pontuar em lote.')
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 50_000)
  // Lê mais do que o limite de saída para o filtro por score ainda ter o que
  // devolver depois de cortar.
  const source = await runFeatureSql(pm.tenantSlug, pm.featureSql, Math.max(limit * 10, 20_000))

  const scored = scoreRows(pm, source)
  const filtered = opts.minScore != null
    ? scored.filter((s) => s.prediction >= opts.minScore!)
    : scored
  filtered.sort((a, b) => b.prediction - a.prediction)

  const keep = opts.keyColumns?.length ? new Set(opts.keyColumns) : null
  const rows = filtered.slice(0, limit).map(({ prediction, row }) => {
    const out: Record<string, unknown> = keep
      ? Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)))
      : { ...row }
    out[pm.task === 'binary' ? 'probabilidade' : 'previsao'] = Number(prediction.toFixed(6))
    return out
  })

  return { scored: scored.length, rows }
}
