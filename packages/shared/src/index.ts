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
  tags: string[]
  ownerEmail: string | null
  fieldCount: number
  rowCount: number | null
  lastSyncAt: string | null
  updatedAt: string
  // Origem física — presente APENAS para admins.
  source?: { connectionId: string; schema: string; table: string }
}

export interface DatasetDetail extends DatasetSummary {
  fields: AdminDatasetField[]
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
  kind: 'postgres' | 'mysql' | 'soap' | 'gcs'
  envPrefix: string
  configured: boolean
  status: 'ok' | 'error' | 'unknown'
  latencyMs: number | null
  error: string | null
}

// ── Auth ──────────────────────────────────────────────────────
export interface SessionUser {
  email: string
  name: string
  picture?: string
  roles: string[]
  tenant: string
}
