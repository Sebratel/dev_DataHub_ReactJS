// Provisiona (idempotente, no boot) o dataset "Saúde das APIs" — a tabela
// api_call_metrics exposta via o conector 'datahub-meta'. Assim o painel de
// observabilidade fica disponível SEM publicação manual. É incremental por `id`
// (bigserial: único, crescente, não-nulo → keyset perfeito) e sincroniza de
// hora em hora.
import { db, isDbAvailable } from '../../db/pool.js'

const FIELDS: [key: string, label: string, type: string][] = [
  ['id', 'ID', 'number'],
  ['dataset_slug', 'Dataset (API)', 'text'],
  ['connection_id', 'Conexão', 'text'],
  ['endpoint', 'Endpoint', 'text'],
  ['status', 'Status HTTP', 'number'],
  ['ok', 'OK', 'bool'],
  ['duration_ms', 'Duração (ms)', 'number'],
  ['rows', 'Linhas', 'number'],
  ['bytes', 'Bytes', 'number'],
  ['error', 'Erro', 'text'],
  ['created_at', 'Quando', 'date'],
]

export async function ensureApiMetricsDataset(): Promise<void> {
  if (!isDbAvailable()) return
  try {
    const tenants = (await db.query('select id, slug from tenants')).rows
    for (const t of tenants) {
      const exists = (await db.query(
        `select 1 from datasets where tenant_id = $1 and connection_id = 'datahub-meta' and object_name = 'api_call_metrics'`,
        [t.id],
      )).rows[0]
      if (exists) continue

      const taken = new Set((await db.query('select slug from datasets where tenant_id = $1', [t.id])).rows.map((r) => r.slug))
      let slug = 'api-metricas'
      for (let i = 2; taken.has(slug); i++) slug = `api-metricas-${i}`

      const ds = (await db.query(
        `insert into datasets (tenant_id, connection_id, schema_name, object_name, slug, name, description,
                               sync_mode, incremental_key, sync_cadence)
         values ($1, 'datahub-meta', 'public', 'api_call_metrics', $2,
                 'Saúde das APIs', 'Latência, status e throughput de cada chamada HTTP ingerida.',
                 'incremental', 'id', 'hourly')
         returning id`,
        [t.id, slug],
      )).rows[0]

      for (const [i, [key, label, type]] of FIELDS.entries()) {
        await db.query(
          `insert into dataset_fields (dataset_id, source_column, key, label, type, sort_order)
           values ($1, $2, $3, $4, $5, $6)`,
          [ds.id, key, key, label, type, i],
        )
      }
      console.log(`[api-metrics] dataset "${slug}" provisionado (tenant ${t.slug}).`)
    }
  } catch (e) {
    console.warn(`[api-metrics] provisionamento falhou: ${(e as Error).message}`)
  }
}
