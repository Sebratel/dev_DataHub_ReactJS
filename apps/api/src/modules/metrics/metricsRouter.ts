// Biblioteca de Métricas — definição única e reutilizável (docs §6 do produto).
// Todos leem; editores/admins criam; dono ou admin altera/apaga.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { Metric, Aggregation, QueryFilter } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { accessibleDatasetIds, canQuery } from '../../core/access.js'

export const metricsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct'])
const FORMATS = new Set(['number', 'currency', 'percent'])

function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'metrica'
}

const FILTER_OPS = new Set([
  '=', '!=', '>', '>=', '<', '<=', 'contains', 'starts_with', 'in', 'not_in', 'is_null', 'not_null', 'between',
])
// Filtros embutidos da métrica (ex.: "protocolos onde title = 'instalação'").
// Validamos campo (tem de existir e estar visível no dataset) e operador; o
// compilador aplica como FILTER (WHERE …) na agregação.
async function parseFilters(raw: unknown, datasetId: string): Promise<QueryFilter[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('filters deve ser uma lista.')
  if (!raw.length) return []
  const keys = new Set((await db.query(
    `select key from dataset_fields where dataset_id = $1 and not hidden`, [datasetId],
  )).rows.map((r) => String(r.key)))
  return raw.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>
    const field = String(o.field ?? '').trim()
    const op = String(o.op ?? '=')
    if (!keys.has(field)) throw new Error(`Campo de filtro inválido: "${field}".`)
    if (!FILTER_OPS.has(op)) throw new Error(`Operador de filtro inválido: "${op}".`)
    const needsValue = op !== 'is_null' && op !== 'not_null'
    if (needsValue && (o.value === undefined || o.value === null || o.value === '')) {
      throw new Error(`Informe o valor do filtro em "${field}".`)
    }
    return { field, op: op as QueryFilter['op'], ...(needsValue ? { value: o.value } : {}) }
  })
}

function toMetric(row: Record<string, unknown>): Metric {
  return {
    id: String(row.id), slug: String(row.slug), name: String(row.name),
    description: String(row.description ?? ''),
    datasetId: String(row.dataset_id), datasetSlug: String(row.dataset_slug),
    datasetName: String(row.dataset_name),
    agg: row.agg as Aggregation, fieldKey: String(row.field_key),
    filters: (row.filters ?? []) as QueryFilter[],
    format: row.format as Metric['format'],
    ownerEmail: (row.owner_email as string) ?? null,
  }
}

const LIST_SQL = `
  select m.*, d.slug as dataset_slug, d.name as dataset_name
    from metrics m join datasets d on d.id = m.dataset_id
    join tenants t on t.id = m.tenant_id
   where t.slug = $1`

// A métrica HERDA o acesso do seu conjunto: quem vê o conjunto, vê a métrica.
metricsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(`${LIST_SQL} order by d.name, m.name`, [req.user!.tenant])).rows
  const allowed = await accessibleDatasetIds(req.user!)
  res.json({ metrics: rows.filter((r) => allowed.has(String(r.dataset_id))).map(toMetric) })
})

metricsRouter.post('/', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { datasetId, name, description, agg, fieldKey, filters, format } = req.body ?? {}
  if (!datasetId || !name || !agg || !fieldKey) {
    return res.status(400).json({ error: 'datasetId, name, agg e fieldKey são obrigatórios.' })
  }
  if (!AGGS.has(agg)) return res.status(400).json({ error: `Agregação inválida: ${agg}` })
  if (format && !FORMATS.has(format)) return res.status(400).json({ error: `Formato inválido: ${format}` })
  // Só cria métrica sobre um conjunto ao qual você tem acesso.
  if (!(await canQuery(req.user!, String(datasetId)))) {
    return res.status(403).json({ error: 'Você não tem acesso a este conjunto de dados.' })
  }
  const field = (await db.query(
    `select 1 from dataset_fields where dataset_id = $1 and key = $2 and not hidden`,
    [datasetId, fieldKey],
  )).rows[0]
  if (!field) return res.status(400).json({ error: 'fieldKey precisa ser um campo visível do dataset.' })

  let parsedFilters: QueryFilter[]
  try {
    parsedFilters = await parseFilters(filters, String(datasetId))
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message })
  }

  const base = slugify(String(name))
  const taken = new Set((await db.query(
    `select m.slug from metrics m join tenants t on t.id = m.tenant_id where t.slug = $1`,
    [req.user!.tenant],
  )).rows.map((r) => r.slug))
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

  const row = (await db.query(
    `insert into metrics (tenant_id, dataset_id, slug, name, description, agg, field_key, filters, format, owner_email)
     select t.id, $1, $2, $3, $4, $5, $6, $7, $8, $9 from tenants t where t.slug = $10
     returning id`,
    [datasetId, slug, String(name).trim(), String(description || ''), agg, fieldKey,
     JSON.stringify(parsedFilters), format || 'number', req.user!.email, req.user!.tenant],
  )).rows[0]
  await audit(req, 'metrics.create', { type: 'metric', id: slug })
  res.status(201).json({ id: row.id, slug })
})

metricsRouter.patch('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { name, description, format, agg, fieldKey, filters } = req.body ?? {}
  const admin = req.user!.roles.includes('admin')

  // Localiza a métrica (respeitando a posse) para validar campo/filtros contra
  // o dataset dela — a definição (agg/campo/filtros) agora é editável.
  const cur = (await db.query(
    `select m.* from metrics m join tenants t on t.id = m.tenant_id
      where t.slug = $1 and m.id = $2 ${admin ? '' : 'and m.owner_email = $3'}`,
    admin ? [req.user!.tenant, req.params.id] : [req.user!.tenant, req.params.id, req.user!.email],
  )).rows[0]
  if (!cur) return res.status(404).json({ error: 'Métrica não encontrada (ou você não é o dono).' })

  if (agg !== undefined && !AGGS.has(agg)) return res.status(400).json({ error: `Agregação inválida: ${agg}` })
  if (format !== undefined && format && !FORMATS.has(format)) return res.status(400).json({ error: `Formato inválido: ${format}` })
  if (fieldKey !== undefined) {
    const ok = (await db.query(
      `select 1 from dataset_fields where dataset_id = $1 and key = $2 and not hidden`,
      [cur.dataset_id, fieldKey],
    )).rows[0]
    if (!ok) return res.status(400).json({ error: 'fieldKey precisa ser um campo visível do dataset.' })
  }
  let parsedFilters: QueryFilter[] | null = null
  if (filters !== undefined) {
    try { parsedFilters = await parseFilters(filters, String(cur.dataset_id)) }
    catch (e) { return res.status(400).json({ error: (e as Error).message }) }
  }

  await db.query(
    `update metrics set
       name = coalesce($2, name), description = coalesce($3, description),
       format = coalesce($4, format), agg = coalesce($5, agg), field_key = coalesce($6, field_key),
       filters = case when $7::jsonb is not null then $7::jsonb else filters end,
       updated_at = now()
     where id = $1`,
    [cur.id, name ?? null, description ?? null, format ?? null, agg ?? null, fieldKey ?? null,
     parsedFilters ? JSON.stringify(parsedFilters) : null],
  )
  await audit(req, 'metrics.update', { type: 'metric', id: String(cur.slug) })
  res.json({ ok: true })
})

metricsRouter.delete('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const admin = req.user!.roles.includes('admin')
  const row = (await db.query(
    `delete from metrics where id = $1 ${admin ? '' : 'and owner_email = $2'} returning slug`,
    admin ? [req.params.id] : [req.params.id, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Métrica não encontrada (ou você não é o dono).' })
  await audit(req, 'metrics.delete', { type: 'metric', id: String(row.slug) })
  res.json({ ok: true })
})
