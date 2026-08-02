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
  ['check_type', 'Origem', 'text'], // 'sync' (ingestão) | 'healthcheck' (uptime)
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

// Derivado com percentis/ratios que os widgets não calculam sozinhos (P95/P99,
// taxa de erro, uptime) — um resumo por endpoint. Materializa pelo scheduler.
const API_SUMMARY_SQL = `select
  endpoint,
  count(*) as chamadas,
  sum(case when not ok then 1 else 0 end) as erros,
  round(100.0 * sum(case when not ok then 1 else 0 end) / count(*), 2) as taxa_erro_pct,
  round(avg(duration_ms)) as latencia_media_ms,
  round(quantile_cont(duration_ms, 0.50)) as p50_ms,
  round(quantile_cont(duration_ms, 0.95)) as p95_ms,
  round(quantile_cont(duration_ms, 0.99)) as p99_ms,
  max(duration_ms) as latencia_max_ms,
  sum(case when status >= 400 and status < 500 then 1 else 0 end) as erros_4xx,
  sum(case when status >= 500 then 1 else 0 end) as erros_5xx,
  round(100.0 * sum(case when ok then 1 else 0 end) / count(*), 2) as uptime_pct
from api_metricas
group by endpoint
order by chamadas desc`

export async function ensureApiSummaryDerived(): Promise<void> {
  if (!isDbAvailable()) return
  try {
    const tenants = (await db.query('select id, slug from tenants')).rows
    for (const t of tenants) {
      const base = (await db.query(
        `select 1 from datasets where tenant_id = $1 and connection_id = 'datahub-meta' and object_name = 'api_call_metrics'`, [t.id],
      )).rows[0]
      if (!base) continue
      const taken = (await db.query('select 1 from datasets where tenant_id = $1 and slug = $2', [t.id, 'api-resumo'])).rows[0]
      if (taken) continue
      await db.query(
        `insert into datasets (tenant_id, kind, transform_sql, connection_id, schema_name, object_name,
                               slug, name, description, sync_mode, sync_cadence, owner_email)
         values ($1, 'derived', $2, 'lake', 'derived', 'api-resumo', 'api-resumo',
                 'Saúde das APIs — resumo', 'P50/P95/P99, taxa de erro e uptime por endpoint.',
                 'snapshot', 'hourly', 'sistema@datahub')`,
        [t.id, API_SUMMARY_SQL],
      )
      console.log(`[api-metrics] derivado "api-resumo" provisionado (tenant ${t.slug}).`)
    }
  } catch (e) {
    console.warn(`[api-metrics] derivado falhou: ${(e as Error).message}`)
  }
}

// Provisiona (idempotente) um dashboard "Saúde das APIs" pronto, com widgets
// sobre o dataset de métricas. Só cria uma vez; o admin edita/adiciona depois.
export async function ensureApiMetricsDashboard(): Promise<void> {
  if (!isDbAvailable()) return
  try {
    const tenants = (await db.query('select id, slug from tenants')).rows
    for (const t of tenants) {
      const ds = (await db.query(
        `select id from datasets where tenant_id = $1 and connection_id = 'datahub-meta' and object_name = 'api_call_metrics'`,
        [t.id],
      )).rows[0]
      if (!ds) continue
      const exists = (await db.query(
        `select 1 from dashboards where tenant_id = $1 and name = 'Saúde das APIs'`, [t.id],
      )).rows[0]
      if (exists) continue

      const dash = (await db.query(
        `insert into dashboards (tenant_id, name, description, owner_email, visibility)
         values ($1, 'Saúde das APIs', 'Latência, throughput e erros das chamadas HTTP (ingestão + uptime).', 'sistema@datahub', 'tenant')
         returning id`,
        [t.id],
      )).rows[0]

      const der = (await db.query('select id from datasets where tenant_id = $1 and slug = $2', [t.id, 'api-resumo'])).rows[0]
      type W = { datasetId: string; title: string; type: string; dimension: string | null; metric: unknown; filters: unknown[]; size: string }
      const b = String(ds.id)
      const widgets: W[] = [
        // Sobre as métricas cruas (api-metricas)
        { datasetId: b, title: 'Chamadas (total)', type: 'kpi', dimension: null, metric: { field: 'id', agg: 'count' }, filters: [], size: 'sm' },
        { datasetId: b, title: 'Erros', type: 'kpi', dimension: null, metric: { field: 'id', agg: 'count' }, filters: [{ field: 'ok', op: '=', value: false }], size: 'sm' },
        { datasetId: b, title: 'Erros 4xx', type: 'kpi', dimension: null, metric: { field: 'id', agg: 'count' }, filters: [{ field: 'status', op: '>=', value: 400 }, { field: 'status', op: '<', value: 500 }], size: 'sm' },
        { datasetId: b, title: 'Erros 5xx', type: 'kpi', dimension: null, metric: { field: 'id', agg: 'count' }, filters: [{ field: 'status', op: '>=', value: 500 }], size: 'sm' },
        { datasetId: b, title: 'Chamadas ao longo do tempo', type: 'line', dimension: 'created_at', metric: { field: 'id', agg: 'count' }, filters: [], size: 'lg' },
        { datasetId: b, title: 'Latência média por endpoint (ms)', type: 'bar', dimension: 'endpoint', metric: { field: 'duration_ms', agg: 'avg' }, filters: [], size: 'md' },
        { datasetId: b, title: 'Chamadas por origem', type: 'pie', dimension: 'check_type', metric: { field: 'id', agg: 'count' }, filters: [], size: 'md' },
        // Sobre o resumo (percentis/ratios) — api-resumo
        ...(der ? [
          { datasetId: String(der.id), title: 'Latência P95 por endpoint (ms)', type: 'bar', dimension: 'endpoint', metric: { field: 'p95_ms', agg: 'max' }, filters: [], size: 'md' },
          { datasetId: String(der.id), title: 'Latência P99 por endpoint (ms)', type: 'bar', dimension: 'endpoint', metric: { field: 'p99_ms', agg: 'max' }, filters: [], size: 'md' },
          { datasetId: String(der.id), title: 'Taxa de erro % por endpoint', type: 'bar', dimension: 'endpoint', metric: { field: 'taxa_erro_pct', agg: 'max' }, filters: [], size: 'md' },
        ] as W[] : []),
      ]
      for (const [i, w] of widgets.entries()) {
        await db.query(
          `insert into widgets (dashboard_id, dataset_id, title, type, dimension, metric, filters, size, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [dash.id, w.datasetId, w.title, w.type, w.dimension, JSON.stringify(w.metric), JSON.stringify(w.filters), w.size, i],
        )
      }
      console.log(`[api-metrics] dashboard "Saúde das APIs" provisionado (tenant ${t.slug}).`)
    }
  } catch (e) {
    console.warn(`[api-metrics] dashboard falhou: ${(e as Error).message}`)
  }
}
