// Biblioteca de Métricas — definição única e reutilizável (docs §6 do produto).
// Todos leem; editores/admins criam; dono ou admin altera/apaga.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { Metric, Aggregation, QueryFilter } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'

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

metricsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(`${LIST_SQL} order by d.name, m.name`, [req.user!.tenant])).rows
  res.json({ metrics: rows.map(toMetric) })
})

metricsRouter.post('/', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { datasetId, name, description, agg, fieldKey, filters, format } = req.body ?? {}
  if (!datasetId || !name || !agg || !fieldKey) {
    return res.status(400).json({ error: 'datasetId, name, agg e fieldKey são obrigatórios.' })
  }
  if (!AGGS.has(agg)) return res.status(400).json({ error: `Agregação inválida: ${agg}` })
  if (format && !FORMATS.has(format)) return res.status(400).json({ error: `Formato inválido: ${format}` })
  const field = (await db.query(
    `select 1 from dataset_fields where dataset_id = $1 and key = $2 and not hidden`,
    [datasetId, fieldKey],
  )).rows[0]
  if (!field) return res.status(400).json({ error: 'fieldKey precisa ser um campo visível do dataset.' })

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
     JSON.stringify(filters ?? []), format || 'number', req.user!.email, req.user!.tenant],
  )).rows[0]
  await audit(req, 'metrics.create', { type: 'metric', id: slug })
  res.status(201).json({ id: row.id, slug })
})

metricsRouter.patch('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { name, description, format } = req.body ?? {}
  const admin = req.user!.roles.includes('admin')
  const row = (await db.query(
    `update metrics set
       name = coalesce($2, name), description = coalesce($3, description),
       format = coalesce($4, format), updated_at = now()
     where id = $1 ${admin ? '' : 'and owner_email = $5'} returning slug`,
    admin ? [req.params.id, name ?? null, description ?? null, format ?? null]
          : [req.params.id, name ?? null, description ?? null, format ?? null, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Métrica não encontrada (ou você não é o dono).' })
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
