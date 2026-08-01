// ─────────────────────────────────────────────────────────────────────────
// Contratos compartilhados entre web e api. O usuário final (e a IA) nunca
// escrevem SQL: toda consulta é um QueryDef, compilado no backend com guard
// e permissões. Ver docs/01-ARQUITETURA-MVP.md §8.
// ─────────────────────────────────────────────────────────────────────────

export type FieldType = 'text' | 'number' | 'date' | 'bool' | 'json'

export type FilterOp =
  | '=' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'starts_with' | 'in' | 'not_in' | 'is_null' | 'not_null'
  | 'between'

export interface QueryFilter {
  field: string
  op: FilterOp
  value?: unknown
}

export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'

export type QuerySelect =
  | string // campo simples
  | { field: string; agg: Aggregation; as?: string }
  | { metric: string; as?: string } // métrica da biblioteca

export interface QueryDef {
  dataset: string // slug do dataset
  select?: QuerySelect[]
  filters?: QueryFilter[]
  groupBy?: string[]
  orderBy?: { field: string; dir: 'asc' | 'desc' }[]
  limit?: number
  offset?: number
  search?: string // busca livre em campos texto
}

export interface QueryResult {
  columns: { name: string; type: FieldType }[]
  rows: Record<string, unknown>[]
  total?: number
  tookMs: number
  source: 'lake' | 'live'
}

// ── Catálogo ──────────────────────────────────────────────────
export interface DatasetSummary {
  id: string
  slug: string
  name: string
  description: string
  // 'source' = ingerido de uma fonte; 'derived' = SQL sobre o lake (Sprint 7).
  kind: 'source' | 'derived'
  // Selo "oficial" — chancelado pela diretoria como fonte de verdade (só admin marca).
  official: boolean
  tags: string[]
  ownerEmail: string | null
  fieldCount: number
  rowCount: number | null
  lastSyncAt: string | null
  updatedAt: string
  // Origem física — presente APENAS para admins.
  source?: { connectionId: string; schema: string; table: string }
  // Configuração de sincronização — presente APENAS para admins.
  sync?: {
    mode: 'live' | 'snapshot' | 'incremental'
    incrementalKey: string | null
    cadence: 'daily' | 'hourly' | 'manual'
    // Piso da 1ª carga incremental (valor da chave). null = desde o início.
    since: string | null
  }
}

export interface SyncRun {
  id: string
  mode: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  rows: number
  bytes: number
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface DatasetDetail extends DatasetSummary {
  fields: AdminDatasetField[]
  // SQL do conjunto derivado — presente apenas para editores/admins.
  transformSql?: string | null
}

export interface AdminDatasetField {
  id: string
  key: string
  label: string
  description: string | null
  type: FieldType
  hidden: boolean // só admins recebem campos hidden (para poder reexibi-los)
  sensitive: boolean
  sortOrder: number
}

export interface DatasetMeta {
  slug: string
  name: string
  description: string
  tags: string[]
  ownerEmail: string | null
  rowCount: number | null
  lastSyncAt: string | null
  fields: DatasetField[]
}

export interface DatasetField {
  key: string // nome exposto (nunca a coluna física)
  label: string
  description: string | null
  type: FieldType
  sensitive: boolean
}

// ── Conexões (admin) ──────────────────────────────────────────
export interface ConnectionInfo {
  id: string
  name: string
  kind: 'postgres' | 'mysql' | 'http' | 'soap' | 'gcs'
  envPrefix: string | null
  configured: boolean
  status: 'ok' | 'error' | 'unknown'
  latencyMs: number | null
  error: string | null
  // managed = tem config no banco (gerenciada ou sobreposição de nativa).
  // native = existe uma versão fixa no .env com este id (editar sobrepõe;
  // excluir a sobreposição reverte para o .env). Detalhe sem senha p/ editar.
  managed: boolean
  native: boolean
  detail?: { host: string; port: number; database: string; username: string; ssl: boolean }
  // Para conexões HTTP (sem o token): base e header de auth, p/ editar/publicar.
  http?: { baseUrl: string; authHeader: string | null; authScheme: string | null }
}

// ── Métricas ──────────────────────────────────────────────────
export interface Metric {
  id: string
  slug: string
  name: string
  description: string
  datasetId: string
  datasetSlug: string
  datasetName: string
  agg: Aggregation
  fieldKey: string
  filters: QueryFilter[]
  format: 'number' | 'currency' | 'percent'
  ownerEmail: string | null
}

// ── Dashboards ────────────────────────────────────────────────
export type WidgetType = 'kpi' | 'line' | 'bar' | 'pie' | 'area' | 'table'

export interface Widget {
  id: string
  title: string
  type: WidgetType
  datasetId: string
  datasetSlug: string
  dimension: string | null
  metric: { metric: string } | { field: string; agg: Aggregation }
  filters: QueryFilter[]
  size: 'sm' | 'md' | 'lg'
  sortOrder: number
}

export interface DashboardSummary {
  id: string
  name: string
  description: string
  ownerEmail: string
  widgetCount: number
  updatedAt: string
}

export interface DashboardDetail extends DashboardSummary {
  widgets: Widget[]
}

// ── Explorador ────────────────────────────────────────────────
// Estado salvo de uma visualização do Explorador.
export interface ViewDefinition {
  filters?: QueryFilter[]
  orderBy?: { field: string; dir: 'asc' | 'desc' }[]
  groupBy?: string | null
  hiddenColumns?: string[]
  search?: string
  pageSize?: number
}

export interface SavedView {
  id: string
  name: string
  definition: ViewDefinition
  ownerEmail: string
  shared: boolean
  updatedAt: string
}

// ── Auth ──────────────────────────────────────────────────────
export interface SessionUser {
  email: string
  name: string
  picture?: string
  roles: string[]
  tenant: string
}
