// ─────────────────────────────────────────────────────────────────────────
// Tools da IA (docs §12). A IA NUNCA escreve SQL: ela consulta o catálogo e
// monta QueryDef, executado pelo MESMO compilador/permissões do usuário
// logado — a IA só vê o que ele pode ver.
// ─────────────────────────────────────────────────────────────────────────
import type { QueryDef, SessionUser, FieldType } from '@datahub/shared'
import { db } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { accessibleDatasetIds, canQuery } from '../../core/access.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { embedQuery, toVectorLiteral, embeddingsEnabled } from './embeddings.js'
import type { AiToolDef } from './provider.js'

export const AI_TOOLS: AiToolDef[] = [
  {
    name: 'search_datasets',
    description: 'Busca conjuntos de dados por SIGNIFICADO (busca semântica). Passe em "query" a intenção do usuário em linguagem natural (ex.: "clientes que cancelaram", "faturamento por plano") — não precisa acertar o nome exato do conjunto. Retorna os mais relevantes (nome, slug, descrição, nº de registros). Sem query, lista todos. Chame primeiro para descobrir onde estão os dados da pergunta.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Intenção/tema em linguagem natural. Ex.: "clientes ativos por cidade".' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_dataset_schema',
    description: 'Retorna os campos de um conjunto (key, rótulo, tipo, descrição) e as métricas da biblioteca disponíveis. Chame antes de montar uma consulta.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Slug do conjunto de dados' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_query',
    description: 'Executa uma consulta estruturada (QueryDef) sobre um conjunto sincronizado no lake e retorna as linhas. Use os KEYS dos campos (não os rótulos). Para agregar: select com {field, agg, as} + groupBy. Operadores de filtro: =, !=, >, >=, <, <=, contains, starts_with, in, is_null, not_null, between.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Slug do conjunto' },
        select: { type: 'array', items: {}, description: 'Campos (string) e/ou agregações {field, agg, as} ou métricas {metric, as}' },
        filters: { type: 'array', items: {}, description: 'Lista de {field, op, value}' },
        groupBy: { type: 'array', items: { type: 'string' } },
        orderBy: { type: 'array', items: {}, description: 'Lista de {field, dir}' },
        limit: { type: 'number' },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
  },
  {
    name: 'render_chart',
    description: 'Mostra um gráfico para o usuário a partir de um conjunto sincronizado. Use depois de validar com run_query que os dados existem. type kpi não usa dimension.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['kpi', 'line', 'bar', 'pie', 'area', 'table'] },
        title: { type: 'string' },
        dataset: { type: 'string', description: 'Slug do conjunto' },
        dimension: { type: 'string', description: 'Campo do eixo/categoria (omitir para kpi)' },
        metric: { type: 'object', description: '{metric: slug} da biblioteca OU {field, agg}' },
        filters: { type: 'array', items: {} },
      },
      required: ['type', 'dataset', 'metric'],
      additionalProperties: false,
    },
  },
]

// Tool exclusiva do CONSTRUTOR de widgets do dashboard (não entra no chat): a
// IA devolve uma LISTA de widgets prontos para o usuário adicionar a uma aba.
// Cada widget é validado (a consulta é executada) antes de ser proposto.
export const PROPOSE_WIDGETS_TOOL: AiToolDef = {
  name: 'propose_widgets',
  description: 'Propõe um ou mais widgets prontos para o dashboard. Chame UMA vez, no fim. Cada widget vira um cartão que o usuário adiciona à aba. Só use conjuntos e campos reais (via get_dataset_schema). Se algum widget for inválido, a tool devolve o erro e você corrige e chama de novo.',
  inputSchema: {
    type: 'object',
    properties: {
      widgets: {
        type: 'array',
        description: 'Lista de widgets (1 a 6). Cada item: {type, dataset(slug), title, dimension?, metric, filters?, style?}',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['kpi', 'line', 'bar', 'pie', 'area', 'table'] },
            dataset: { type: 'string', description: 'Slug do conjunto' },
            title: { type: 'string', description: 'Título curto em português' },
            dimension: { type: 'string', description: 'Campo do eixo/categoria (omitir para kpi)' },
            metric: { type: 'object', description: '{metric: slug} da biblioteca OU {field, agg}' },
            filters: { type: 'array', items: {} },
            style: { type: 'object', description: 'Opcional: {color, numberFormat, showDataLabels, showLegend, target, subtitle}' },
          },
          required: ['type', 'dataset', 'metric'],
          additionalProperties: false,
        },
      },
    },
    required: ['widgets'],
    additionalProperties: false,
  },
}

// Ferramentas do construtor de widgets: reusa a descoberta/validação do chat
// (busca semântica, schema, run_query) e troca render_chart por propose_widgets.
export const WIDGET_BUILDER_TOOLS: AiToolDef[] = [
  ...AI_TOOLS.filter((t) => t.name !== 'render_chart'),
  PROPOSE_WIDGETS_TOOL,
]

export interface ToolOutcome {
  content: string
  isError?: boolean
  chart?: Record<string, unknown> // presença = render_chart bem-sucedido
  widgets?: Record<string, unknown>[] // presença = propose_widgets bem-sucedido
}

// Conjuntos referenciados no input de uma tool (para checar o escopo).
function slugsInInput(name: string, input: Record<string, unknown>): string[] {
  if (name === 'get_dataset_schema') return [String(input.slug ?? '')]
  if (name === 'run_query') return [String(input.dataset ?? '')]
  if (name === 'propose_widgets') {
    const ws = Array.isArray(input.widgets) ? (input.widgets as Record<string, unknown>[]) : []
    return ws.map((w) => String(w.dataset ?? w.datasetSlug ?? ''))
  }
  return []
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  user: SessionUser,
  allowed?: Set<string>, // se definido, a IA só pode tocar nestes conjuntos (slug)
): Promise<ToolOutcome> {
  try {
    // Escopo: barra qualquer conjunto fora da seleção (exceto a busca, que já é filtrada).
    if (allowed && name !== 'search_datasets') {
      const refs = slugsInInput(name, input).filter(Boolean)
      const fora = refs.filter((s) => !allowed.has(s))
      if (fora.length) {
        return { content: `Fora do escopo: ${fora.join(', ')}. Use SOMENTE: ${[...allowed].join(', ')}.`, isError: true }
      }
    }
    switch (name) {
      case 'search_datasets': return await searchDatasets(user, input.query ? String(input.query) : undefined, allowed)
      case 'get_dataset_schema': return await getSchema(String(input.slug ?? ''), user)
      case 'run_query': return await runQuery(input as unknown as QueryDef, user)
      case 'render_chart': return await renderChart(input, user)
      case 'propose_widgets': return await proposeWidgets(input, user)
      default: return { content: `Tool desconhecida: ${name}`, isError: true }
    }
  } catch (e) {
    return { content: `Erro: ${(e as Error).message}`, isError: true }
  }
}

// Busca semântica (RAG): se vier `query`, vetorizamos a intenção e ordenamos
// os datasets pela DISTÂNCIA DE COSSENO (operador <=> do pgvector) — menor
// distância = mais parecido. Filtramos pelo acesso do usuário e devolvemos o
// topo. Sem query (ou sem embeddings ainda), caímos no comportamento antigo
// (lista alfabética) — degradação graciosa, o chat nunca quebra.
async function searchDatasets(user: SessionUser, query?: string, scope?: Set<string>): Promise<ToolOutcome> {
  const allowed = await accessibleDatasetIds(user)

  let rows: Record<string, unknown>[] = []
  if (query && query.trim() && embeddingsEnabled()) {
    try {
      const vec = toVectorLiteral(await embedQuery(query.trim()))
      rows = (await db.query(
        `select d.id, d.slug, d.name, d.description, d.row_count, d.last_sync_at,
                (d.embedding <=> $2::vector) as distance
           from datasets d join tenants t on t.id = d.tenant_id
          where t.slug = $1 and d.embedding is not null
          order by d.embedding <=> $2::vector
          limit 50`,
        [user.tenant, vec],
      )).rows
    } catch (e) {
      // Vetorização indisponível → não quebra o chat; cai no fallback textual.
      console.warn(`[ai] busca semântica falhou, usando fallback textual: ${(e as Error).message}`)
      rows = []
    }
  }

  // Fallback: sem query, ou nenhum dataset indexado ainda → lista alfabética.
  if (!rows.length) {
    rows = (await db.query(
      `select d.id, d.slug, d.name, d.description, d.row_count, d.last_sync_at
         from datasets d join tenants t on t.id = d.tenant_id
        where t.slug = $1 order by d.name`,
      [user.tenant],
    )).rows
  }

  const list = rows
    .filter((r) => allowed.has(String(r.id))) // só o que o usuário acessa (após ordenar)
    .filter((r) => !scope || scope.has(String(r.slug))) // escopo selecionado no painel
    .slice(0, query ? 8 : 50)                 // busca → só os mais relevantes
    .map((r) => ({
      slug: r.slug, name: r.name, description: r.description,
      rows: r.row_count, sincronizado: !!r.last_sync_at,
    }))
  return { content: JSON.stringify(list) }
}

async function loadDataset(slug: string, user: SessionUser) {
  const ds = (await db.query(
    `select d.* , t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [user.tenant, slug],
  )).rows[0]
  if (!ds) throw new Error(`Conjunto não encontrado: ${slug}`)
  // A IA age como o usuário: sem acesso, o conjunto "não existe" para ela.
  if (!(await canQuery(user, String(ds.id)))) {
    throw new Error(`Conjunto não encontrado: ${slug}`)
  }
  return ds
}

async function getSchema(slug: string, user: SessionUser): Promise<ToolOutcome> {
  const ds = await loadDataset(slug, user)
  const fields = (await db.query(
    `select key, label, description, type, sensitive from dataset_fields
      where dataset_id = $1 and not hidden order by sort_order`,
    [ds.id],
  )).rows
  const metrics = (await db.query(
    `select slug, name, description, agg, field_key, format from metrics where dataset_id = $1`,
    [ds.id],
  )).rows
  return { content: JSON.stringify({ dataset: slug, fields, metrics }) }
}

async function executeQueryDef(def: QueryDef, user: SessionUser) {
  const ds = await loadDataset(def.dataset, user)
  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    throw new Error(`O conjunto "${def.dataset}" ainda não foi sincronizado com o lake.`)
  }
  const fields = (await db.query(
    `select key, type, sensitive from dataset_fields where dataset_id = $1 and not hidden`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean }[]
  const metrics = (await db.query(
    `select slug, agg, field_key as "fieldKey", filters from metrics where dataset_id = $1`,
    [ds.id],
  )).rows
  const admin = user.roles.includes('admin')
  const compiled = compileQuery(def, fields, {
    admin,
    glob: parquetGlob(dir),
    metrics: metrics as never,
  })
  return duckQuery(compiled.sql, compiled.params, { timeoutMs: config.duck.queryTimeoutMs })
}

async function runQuery(def: QueryDef, user: SessionUser): Promise<ToolOutcome> {
  const { rows } = await executeQueryDef({ ...def, limit: Math.min(def.limit ?? 100, 500) }, user)
  return { content: JSON.stringify({ rowCount: rows.length, rows: rows.slice(0, 100) }) }
}

// Monta o MESMO QueryDef que o widget executará no frontend (fonte única da
// verdade para render_chart e propose_widgets).
function widgetSpecToQueryDef(
  type: string, slug: string, dimension: string | null,
  metric: Record<string, unknown>, filters: unknown,
): QueryDef {
  const metricSel = 'metric' in metric
    ? { metric: String(metric.metric), as: 'valor' }
    : { field: String(metric.field), agg: metric.agg as never, as: 'valor' }
  if (type === 'kpi') {
    return { dataset: slug, select: [metricSel as never], filters: (filters as never) ?? [], limit: 1 }
  }
  return {
    dataset: slug,
    select: [dimension!, metricSel as never],
    filters: (filters as never) ?? [],
    groupBy: [dimension!],
    orderBy: [{ field: type === 'line' || type === 'area' ? dimension! : 'valor', dir: type === 'line' || type === 'area' ? 'asc' : 'desc' }],
    limit: type === 'pie' ? 8 : 100,
  }
}

async function renderChart(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const type = String(input.type)
  const slug = String(input.dataset)
  const dimension = input.dimension ? String(input.dimension) : null
  const metric = input.metric as Record<string, unknown>
  if (type !== 'kpi' && !dimension) {
    return { content: 'Gráficos (exceto kpi) exigem dimension.', isError: true }
  }
  const def = widgetSpecToQueryDef(type, slug, dimension, metric, input.filters)
  const { rows } = await executeQueryDef(def, user)
  const chart = {
    type, title: String(input.title ?? ''), datasetSlug: slug,
    dimension, metric, filters: input.filters ?? [],
  }
  return {
    content: `Gráfico exibido ao usuário (${rows.length} ponto(s) de dados).`,
    chart,
  }
}

const WIDGET_TYPES = new Set(['kpi', 'line', 'bar', 'pie', 'area', 'table'])

// Valida UM widget proposto: tipo/dimensão coerentes, conjunto acessível e a
// consulta REALMENTE roda (campos existem, está sincronizado). Devolve o widget
// normalizado (com datasetId, para o POST /widgets) ou uma mensagem de erro.
async function validateSpec(
  spec: Record<string, unknown>, user: SessionUser,
): Promise<{ ok: true; widget: Record<string, unknown> } | { ok: false; error: string }> {
  const type = String(spec.type ?? '')
  if (!WIDGET_TYPES.has(type)) return { ok: false, error: `tipo inválido "${type}"` }
  const slug = String(spec.dataset ?? spec.datasetSlug ?? '')
  if (!slug) return { ok: false, error: 'conjunto (dataset) ausente' }
  const dimension = spec.dimension ? String(spec.dimension) : null
  const metric = spec.metric as Record<string, unknown> | undefined
  if (!metric) return { ok: false, error: 'métrica ausente' }
  if (type !== 'kpi' && !dimension) return { ok: false, error: `o widget "${spec.title || type}" precisa de dimension` }
  try {
    const ds = await loadDataset(slug, user)
    const def = widgetSpecToQueryDef(type, slug, dimension, metric, spec.filters)
    await executeQueryDef(def, user) // lança se um campo não existe ou não há dados
    return {
      ok: true,
      widget: {
        type, title: String(spec.title ?? ''), datasetSlug: slug, datasetId: String(ds.id),
        dimension, metric, filters: spec.filters ?? [], style: spec.style ?? null,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function proposeWidgets(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const specs = Array.isArray(input.widgets) ? (input.widgets as Record<string, unknown>[]) : []
  if (!specs.length) return { content: 'Informe ao menos um widget em "widgets".', isError: true }
  const valid: Record<string, unknown>[] = []
  const errors: string[] = []
  for (const [i, s] of specs.entries()) {
    const r = await validateSpec(s, user)
    if (r.ok) valid.push(r.widget)
    else errors.push(`widget ${i + 1} (${s.title || s.type || '?'}): ${r.error}`)
  }
  if (errors.length) {
    return {
      content: `Alguns widgets são inválidos — corrija (use get_dataset_schema para os campos certos) e chame propose_widgets de novo:\n- ${errors.join('\n- ')}`,
      isError: true,
    }
  }
  return { content: `${valid.length} widget(s) validado(s) e proposto(s) ao usuário.`, widgets: valid }
}
