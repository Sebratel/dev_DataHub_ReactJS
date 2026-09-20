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
    // 2ª chave incremental: uma passada por chave (ex.: created + modified), o
    // que permite pegar o que foi CRIADO e o que foi EDITADO no mesmo sync.
    // Exige dedupeKeys — sem identidade, as duas passadas duplicariam a linha.
    incrementalKey2: string | null
    cadence: 'daily' | 'hourly' | 'manual' | 'cascade' | 'schedule'
    scheduleId?: string | null
    // Piso da 1ª carga incremental (valor da chave). null = desde o início.
    since: string | null
    // Piso RELATIVO, em dias — alternativa ao `since` fixo. Exclusivos entre si.
    sinceDays: number | null
    // Identidade da linha. Vazio = só-acrescenta (comportamento antigo);
    // preenchido = upsert, a versão mais recente substitui a anterior.
    dedupeKeys: string[]
    // Rebobina o watermark N minutos a cada sync, para não perder edição que
    // chega com carimbo retroativo. A compactação absorve a releitura.
    watermarkLagMinutes: number
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
  writable: boolean // pode receber escrita (produtos de escrita)
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
// Tipos de visual. Os 6 primeiros são o legado; os demais entram com o modelo
// rico (múltiplas medidas/dimensões, séries, combo, dispersão, funil, texto).
export type WidgetType =
  | 'kpi' | 'line' | 'bar' | 'pie' | 'area' | 'table'
  | 'barH' | 'barStacked' | 'barHStacked' | 'comboBarLine' | 'scatter' | 'funnel' | 'text'

// Uma medida (série): agregação de um campo OU métrica da biblioteca, com
// rótulo e cor opcionais. Cada medida adicionada vira uma série no gráfico.
export interface MeasureConfig {
  field?: string
  agg?: Aggregation
  metric?: string // métrica da biblioteca (alternativa a field+agg)
  label?: string
  color?: string
}

// Definição de dados rica do widget (o que dimension/metric sozinhos não cobrem).
export interface WidgetSpec {
  dimensions?: string[]        // eixo X / agrupamento (composto se >1)
  measures?: MeasureConfig[]   // eixo Y — cada uma é uma série
  measuresLine?: MeasureConfig[] // comboBarLine: série(s) desenhadas como linha
  measureX?: MeasureConfig     // dispersão: eixo X (numérico)
  legendDimension?: string     // quebra em séries (pivô), até 8 valores
  content?: string             // tipo "text"
  limit?: number               // Top N
  widgetFilters?: QueryFilter[] // filtro fixo do widget
}

// Posição livre no grid de 12 colunas (react-grid-layout). null = auto-flow:
// o cliente calcula um layout inicial a partir de sort_order/size.
export interface WidgetLayout { x: number; y: number; w: number; h: number }

// Formatação condicional (KPI/tabela): pinta conforme o valor cruza um limite.
export interface ConditionalRule {
  op: '>' | '>=' | '<' | '<=' | '=' | '!='
  value: number
  color: string
}

// Personalização visual do widget (Fase 3). Tudo opcional — o render aplica
// defaults de marca quando ausente.
export interface WidgetStyle {
  color?: string                 // cor primária da série
  palette?: string[]             // paleta custom (pizza/multi-série)
  showDataLabels?: boolean       // rótulos de dado no gráfico
  showLegend?: boolean
  numberFormat?: 'number' | 'currency' | 'percent'
  decimals?: number
  target?: number                // linha de meta (bar/line/area)
  conditionalRules?: ConditionalRule[]
  subtitle?: string
}

export interface Widget {
  id: string
  tabId: string
  title: string
  type: WidgetType
  datasetId: string
  datasetSlug: string
  dimension: string | null
  metric: { metric: string } | { field: string; agg: Aggregation }
  filters: QueryFilter[]
  size: 'sm' | 'md' | 'lg'       // legado; fallback quando layout é null
  layout: WidgetLayout | null
  style: WidgetStyle | null
  spec: WidgetSpec | null        // modelo rico (séries, legenda, combo, texto…)
  sortOrder: number
}

// Filtro no nível da aba: aplica a todos os widgets da aba cujo conjunto
// (datasetSlug) contém o campo. multiselect usa op 'in'; daterange usa 'between'.
export interface TabFilter {
  field: string
  label?: string
  kind: 'multiselect' | 'daterange'
  datasetSlug: string // conjunto de onde vêm os valores e a que widgets se aplica
}
export interface TabConfig { autoRefreshSec?: number; filters?: TabFilter[] }

export interface DashboardTab {
  id: string
  label: string
  icon: string | null
  sortOrder: number
  config: TabConfig | null
}

// Configuração do dashboard como um todo (personalização global + modo TV).
export interface DashboardSettings {
  palette?: string[]       // paleta padrão dos widgets sem cor/paleta própria
  autoRefreshSec?: number  // recarrega os dados a cada N segundos (modo painel)
}

export interface DashboardSummary {
  id: string
  name: string
  description: string
  ownerEmail: string
  widgetCount: number
  updatedAt: string
  settings: DashboardSettings | null
}

export interface DashboardDetail extends DashboardSummary {
  tabs: DashboardTab[]
  widgets: Widget[]
  // Agendamentos (ver SyncSchedule) usados por algum dataset por trás dos
  // widgets deste dashboard. Vazio = nenhum widget usa cadencia 'schedule'.
  schedules: SyncSchedule[]
}

// ── Agendamento de sincronizacao (janela + intervalo em minutos) ──────────
// Uma politica NOMEADA e REUTILIZAVEL: aplica-se a varios conjuntos de uma
// vez (ver POST /schedules/:id/assign), e editar o agendamento propaga para
// todos os conjuntos que o usam, sem precisar reaplicar um por um.
export interface SyncSchedule {
  id: string
  name: string
  /** Minutos entre uma sincronizacao e a proxima, DENTRO da janela. */
  intervalMinutes: number
  /** 'HH:MM', hora local do servidor. */
  startTime: string
  endTime: string
  /** Bitmask: bit 0 = domingo .. bit 6 = sabado (Date.getDay()). Ao menos 1 bit. */
  weekdays: number
  datasetCount?: number // presente so na listagem administrativa
  /** Quantos desses conjuntos são de FONTE — editar/apagar o agendamento
   *  mexe na cadência deles, e isso é do admin master. */
  sourceCount?: number
}

export const WEEKDAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const

// Usada nos DOIS lados (agendador no servidor, timer de auto-atualizacao no
// dashboard) -- para o dashboard nao poder "achar" que esta na janela num
// horario diferente do que o servidor realmente vai sincronizar.
export function isWithinSchedule(
  s: { startTime: string; endTime: string; weekdays: number },
  now: Date = new Date(),
): boolean {
  if (!((s.weekdays >> now.getDay()) & 1)) return false
  const [sh, sm] = s.startTime.split(':').map(Number)
  const [eh, em] = s.endTime.split(':').map(Number)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return nowMin >= sh * 60 + sm && nowMin <= eh * 60 + em
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

// ── Produtos de API (construtor self-service do dev) ──────────
// GET = leitura (dataset + paginação + filtros); POST = escrita (INSERT com body).
// Escrita passa por aprovação do admin (status pending → active).
export type ApiProductKind = 'read' | 'write'
export type ApiProductStatus = 'active' | 'pending' | 'rejected'
export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
// Operação de escrita: insert (POST) | update (PUT/PATCH) | delete (DELETE).
export type ApiWriteOp = 'insert' | 'update' | 'delete'

export interface ApiProductColumn {
  col: string
  type: 'text' | 'number' | 'bool' | 'date'
  required?: boolean
}

export interface ApiProduct {
  id: string
  slug: string
  name: string
  kind: ApiProductKind
  method: ApiHttpMethod
  ownerEmail: string
  status: ApiProductStatus
  enabled: boolean
  // Leitura (kind='read')
  datasetSlug: string | null
  pagination: 'page' | 'offset' | null
  defaultLimit: number | null
  maxLimit: number | null
  readFilters: QueryFilter[] | null
  // Escrita (kind='write')
  writeOp: ApiWriteOp | null
  connectionId: string | null
  schemaName: string | null
  tableName: string | null
  columns: ApiProductColumn[] | null       // SET/body (insert e update)
  keyColumns: ApiProductColumn[] | null     // WHERE (update e delete) — obrigatório
  maxAffected: number | null                // teto de linhas afetadas (update/delete)
  reviewedBy: string | null
  reviewedAt: string | null
  createdAt: string
}

// ── Gateway de APIs ───────────────────────────────────────────
// Upstream: uma API interna que JÁ EXISTE e passa a ser servida atrás do
// gateway, ganhando token, quota, tempo limite e telemetria sem que o serviço
// de trás precise mudar nada.
export type GatewayAuthMode = 'none' | 'bearer' | 'header' | 'basic'
export type GatewayUpstreamStatus = 'pending' | 'active' | 'rejected'

export interface GatewayUpstream {
  id: string
  slug: string          // prefixo público: /api/public/v1/gw/<slug>/…
  name: string
  description: string
  baseUrl: string
  authMode: GatewayAuthMode
  authHeader: string | null
  methods: string[]
  timeoutMs: number
  stripPrefix: boolean
  forwardHeaders: string[]
  status: GatewayUpstreamStatus
  enabled: boolean
  ownerEmail: string
  reviewedBy: string | null
  reviewedAt: string | null
  createdAt: string
  /** O segredo do upstream nunca trafega — só se ele existe. */
  hasSecret: boolean
}

// Consumo do dia por token — alimenta o painel de tráfego do gateway.
export interface GatewayUsage {
  id: string
  name: string
  rate_limit_per_min: number | null
  quota_per_day: number | null
  /** Upstreams que este token alcança — opt-in explícito, vazio = nenhum. */
  upstream_slugs: string[]
  calls_today: number
}

// ── Insight de widget ─────────────────────────────────────────
// Leitura de IA sobre UM gráfico: o que os números significam.
export interface WidgetInsight {
  headline: string
  bullets: string[]
  tone: 'positive' | 'attention' | 'neutral'
  provider: string
  model: string
  tookMs: number
  /** true = mesmos dados de antes, texto veio do cache (sem custo). */
  cached: boolean
}

// ── Provedores de IA ──────────────────────────────────────────
// Cadastrados na plataforma, não no .env. 'openai' fala o dialeto Chat
// Completions, então cobre também Azure, Groq, OpenRouter e locais — basta
// trocar a baseUrl.
export type AiProviderKind = 'anthropic' | 'openai' | 'gemini'

export interface AiProvider {
  id: string
  name: string
  kind: AiProviderKind
  model: string
  baseUrl: string | null
  /** Últimos 4 caracteres da chave — só para reconhecimento. */
  keyHint: string | null
  maxTokens: number
  effort: string | null
  enabled: boolean
  isDefault: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  lastTestMs: number | null
  ownerEmail: string
  createdAt: string
  /** A chave existe? O valor jamais trafega. */
  hasKey: boolean
}

export interface AiModelOption { id: string; label: string }

export interface AiProviderTestResult {
  ok: boolean
  ms: number
  error?: string
  sample?: string
}

// ── Notebooks ─────────────────────────────────────────────────
// Célula de notebook. `python` está reservado no tipo mas ainda não executa —
// entra com o runtime Pyodide (WebAssembly, no navegador).
export type NotebookCellKind = 'sql' | 'markdown' | 'python'

export interface NotebookCell {
  id: string
  kind: NotebookCellKind
  source: string
  name?: string
}

export interface NotebookSummary {
  id: string
  slug: string
  name: string
  description: string
  visibility: 'private' | 'tenant'
  owner_email: string
  cell_count: number
  created_at: string
  updated_at: string
}

export interface Notebook extends Omit<NotebookSummary, 'cell_count'> {
  cells: NotebookCell[]
}

// Conjunto referenciável dentro de uma célula SQL. `alias` é como se escreve
// (slug com underscore) — a diferença entre os dois já causou confusão.
export interface NotebookCatalogEntry {
  slug: string
  alias: string
  name: string
  kind: 'source' | 'derived'
  rowCount: number | null
  fieldCount: number
}

export interface NotebookRunResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
  ms: number
}

// ── Modelos preditivos ────────────────────────────────────────
// Os tipos abaixo espelham as linhas cruas do Postgres (snake_case), como já é
// o caso do consumo do gateway — o router devolve `m.*` sem remapear.
export type MlTask = 'binary' | 'regression'
export type MlAlgorithm = 'logistic' | 'linear'
export type MlRetrain = 'manual' | 'daily' | 'weekly'

export interface MlBinaryMetrics {
  auc: number
  accuracy: number
  precision: number
  recall: number
  f1: number
  confusion: { tp: number; fp: number; tn: number; fn: number }
  positiveRate: number
}
export interface MlRegressionMetrics {
  rmse: number
  mae: number
  r2: number
  meanActual: number
}
export type MlMetrics = Partial<MlBinaryMetrics & MlRegressionMetrics>

export interface MlImportance { feature: string; weight: number; abs: number }

export interface MlModel {
  id: string
  slug: string
  name: string
  description: string
  task: MlTask
  algorithm: MlAlgorithm
  feature_sql: string | null
  target_column: string | null
  excluded_columns: string[]
  holdout_pct: number
  max_rows: number
  retrain: MlRetrain
  hyperparams: Record<string, unknown>
  owner_email: string
  promoted_version_id: string | null
  created_at: string
  updated_at: string
  // Agregados da listagem
  promoted_version?: number | null
  promoted_metrics?: MlMetrics | null
  promoted_at?: string | null
  rows_trained?: number | null
  version_count?: number
  last_run_status?: 'running' | 'done' | 'error' | 'canceled' | null
  last_run_error?: string | null
  last_run_at?: string | null
}

export interface MlVersion {
  id: string
  version: number
  metrics: MlMetrics
  importances: MlImportance[] | null
  rows_trained: number | null
  rows_holdout: number | null
  trained_ms: number | null
  status: string
  note: string | null
  created_by: string
  created_at: string
  promoted: boolean
}

export interface MlRun {
  id: string
  status: 'running' | 'done' | 'error' | 'canceled'
  trigger: 'manual' | 'schedule'
  rows: number | null
  error: string | null
  started_at: string
  finished_at: string | null
}

// Prévia dos atributos: o que vira coluna do modelo e o que foi descartado —
// mostrado ANTES de treinar, para o vazamento de alvo aparecer cedo.
export interface MlFeaturePreview {
  sampledRows: number
  columns: string[]
  features: string[]
  featureCount: number
  dropped: { column: string; reason: string }[]
  sample: Record<string, unknown>[]
}

export interface MlTrainOutcome {
  runId: string
  versionId: string
  version: number
  metrics: MlMetrics
  rowsTrained: number
  rowsHoldout: number
  dropped: { column: string; reason: string }[]
  skippedRows: number
}

// ── Admin master ──────────────────────────────────────────────
// Duas origens: 'env' vem de MASTER_ADMIN_EMAILS no servidor e NÃO é removível
// pela tela (é o caminho de recuperação); 'granted' foi concedido por outro
// master em Usuários e Acessos.
export interface MasterAdmin {
  email: string
  origin: 'env' | 'granted'
  grantedBy: string | null
  note: string
  createdAt: string | null
}

// ── Auth ──────────────────────────────────────────────────────
export interface SessionUser {
  email: string
  name: string
  picture?: string
  roles: string[]
  tenant: string
  // ADMIN MASTER: pode mudar COMO as FONTES atualizam (modo, chaves,
  // identidade, cadência). Não é um papel do banco — vem da lista no ambiente
  // do servidor ou de uma concessão feita por outro master, justamente porque
  // qualquer admin consegue conceder 'admin' a si mesmo pela tela de acessos.
  // Conjuntos CALCULADOS seguem com 'editor'.
  master: boolean
  // Existe ALGUÉM como master no servidor? `false` é um estado de configuração
  // quebrada — ninguém consegue mexer nas fontes e não há a quem pedir. Sem
  // este sinal, a tela só saberia dizer "peça ao master", mandando a pessoa
  // procurar alguém que não existe; foi o que aconteceu quando a variável
  // MASTER_ADMIN_EMAILS ficou de fora do docker-compose e nunca chegou à API.
  masterConfigured: boolean
}

// ── Padronização da regra de atualização ──────────────────────
// Proposta de configuração incremental para UM conjunto, deduzida do catálogo
// da tabela de origem (chave primária, índices únicos, cobertura de índice).
export interface PlanProposal {
  mode: 'snapshot' | 'incremental'
  /** Chave da 1ª passada — tipicamente a data de criação. */
  incrementalKey: string | null
  /** Chave da 2ª passada — a data de edição. Exige dedupeKeys. */
  incrementalKey2: string | null
  dedupeKeys: string[]
  watermarkLagMinutes: number
  /** 'schedule' = cabe cadência de minutos (chaves indexadas). */
  cadence: 'daily' | 'hourly' | 'manual' | 'schedule'
}

/** Divergência entre os campos publicados e as colunas que a fonte tem HOJE. */
export interface FieldDrift {
  /** Campos cuja coluna sumiu da fonte. Enquanto existirem, TODA sincronização
   *  falha com «column "x" does not exist» — o SELECT da ingestão as inclui. */
  missing: { key: string; sourceColumn: string }[]
  /** Colunas novas na fonte que ninguém publicou. Não quebram nada. */
  extra: string[]
  /** null quando não foi possível ler as colunas da fonte. */
  checked: boolean
}

/** Como as últimas execuções foram — responde "por que esta fonte não atualiza?". */
export interface SyncHealth {
  lastSuccessAt: string | null
  lastRunAt: string | null
  lastError: string | null
  /** Execuções com erro desde o último sucesso. */
  failuresSinceSuccess: number
  /** true = a última execução falhou. */
  failing: boolean
}

export interface IncrementalPlan {
  datasetId: string
  slug: string
  name: string
  connectionId: string
  schema: string
  table: string
  rowCount: number | null
  drift: FieldDrift
  health: SyncHealth
  current: {
    mode: 'live' | 'snapshot' | 'incremental'
    incrementalKey: string | null
    incrementalKey2: string | null
    dedupeKeys: string[]
    cadence: 'daily' | 'hourly' | 'manual' | 'cascade' | 'schedule'
    watermarkLagMinutes: number
  }
  /** null quando não há regra possível — veja `blocker`. */
  proposed: PlanProposal | null
  /** alta = identidade declarada no banco e chave de data indexada. */
  confidence: 'alta' | 'media' | 'baixa'
  /** true quando o conjunto já está exatamente como o plano propõe. */
  alreadyApplied: boolean
  /** Por que estas colunas foram escolhidas. */
  reasons: string[]
  /** Riscos de aplicar assim — chave sem índice, identidade por palpite… */
  warnings: string[]
  /** Motivo de não haver proposta nenhuma. */
  blocker: string | null
}
