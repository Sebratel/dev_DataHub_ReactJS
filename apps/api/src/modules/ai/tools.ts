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
import type { AiToolDef } from './provider.js'

export const AI_TOOLS: AiToolDef[] = [
  {
    name: 'search_datasets',
    description: 'Lista os conjuntos de dados disponíveis (nome, slug, descrição, nº de registros). Chame primeiro para descobrir onde estão os dados da pergunta.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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

export interface ToolOutcome {
  content: string
  isError?: boolean
  chart?: Record<string, unknown> // presença = render_chart bem-sucedido
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  user: SessionUser,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'search_datasets': return await searchDatasets(user)
      case 'get_dataset_schema': return await getSchema(String(input.slug ?? ''), user)
      case 'run_query': return await runQuery(input as unknown as QueryDef, user)
      case 'render_chart': return await renderChart(input, user)
      default: return { content: `Tool desconhecida: ${name}`, isError: true }
    }
  } catch (e) {
    return { content: `Erro: ${(e as Error).message}`, isError: true }
  }
}

async function searchDatasets(user: SessionUser): Promise<ToolOutcome> {
  const allowed = await accessibleDatasetIds(user)
  const rows = (await db.query(
    `select d.id, d.slug, d.name, d.description, d.row_count, d.last_sync_at
       from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 order by d.name`,
    [user.tenant],
  )).rows.filter((r) => allowed.has(String(r.id))) // só o que o usuário acessa
  const list = rows.map((r) => ({
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

async function renderChart(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const type = String(input.type)
  const slug = String(input.dataset)
  const dimension = input.dimension ? String(input.dimension) : null
  const metric = input.metric as Record<string, unknown>
  if (type !== 'kpi' && !dimension) {
    return { content: 'Gráficos (exceto kpi) exigem dimension.', isError: true }
  }
  // Valida executando a consulta que o widget fará no frontend.
  const metricSel = 'metric' in metric
    ? { metric: String(metric.metric), as: 'valor' }
    : { field: String(metric.field), agg: metric.agg as never, as: 'valor' }
  const def: QueryDef = type === 'kpi'
    ? { dataset: slug, select: [metricSel as never], filters: (input.filters as never) ?? [], limit: 1 }
    : {
        dataset: slug,
        select: [dimension!, metricSel as never],
        filters: (input.filters as never) ?? [],
        groupBy: [dimension!],
        orderBy: [{ field: type === 'line' || type === 'area' ? dimension! : 'valor', dir: type === 'line' || type === 'area' ? 'asc' : 'desc' }],
        limit: type === 'pie' ? 8 : 100,
      }
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
