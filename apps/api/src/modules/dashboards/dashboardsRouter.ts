// Dashboards e widgets. Todos do tenant veem; editores criam; dono ou admin
// edita/apaga. O dado do widget vem do endpoint de query (o widget só guarda
// a definição: dataset + dimensão + métrica + filtros).
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { DashboardSummary, Widget, QueryFilter } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const dashboardsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

const TYPES = new Set(['kpi', 'line', 'bar', 'pie', 'area', 'table'])
const SIZES = new Set(['sm', 'md', 'lg'])

function toSummary(row: Record<string, unknown>): DashboardSummary {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description ?? ''),
    ownerEmail: String(row.owner_email), widgetCount: Number(row.widget_count ?? 0),
    updatedAt: String(row.updated_at),
  }
}

function toWidget(row: Record<string, unknown>): Widget {
  return {
    id: String(row.id), title: String(row.title ?? ''), type: row.type as Widget['type'],
    datasetId: String(row.dataset_id), datasetSlug: String(row.dataset_slug),
    dimension: (row.dimension as string) ?? null,
    metric: row.metric as Widget['metric'],
    filters: (row.filters ?? []) as QueryFilter[],
    size: row.size as Widget['size'], sortOrder: Number(row.sort_order),
  }
}

// Dono, admin ou convidado com level 'edit' pode mexer no dashboard.
async function canEdit(req: Request, dashboardId: string): Promise<boolean> {
  if (req.user!.roles.includes('admin')) return true
  const row = (await db.query('select owner_email from dashboards where id = $1', [dashboardId])).rows[0]
  if (row && row.owner_email === req.user!.email) return true
  const grant = (await db.query(
    `select 1 from dashboard_grants where dashboard_id = $1 and grantee_email = $2 and level = 'edit'`,
    [dashboardId, req.user!.email],
  )).rows[0]
  return !!grant
}

// Visível se: visibilidade 'tenant', OU dono, OU convidado, OU admin.
const VISIBLE_WHERE = `(d.visibility = 'tenant' or d.owner_email = $2 or $3
  or exists (select 1 from dashboard_grants g where g.dashboard_id = d.id and g.grantee_email = $2))`

dashboardsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(
    `select d.*, (select count(*) from widgets w where w.dashboard_id = d.id) as widget_count
       from dashboards d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and ${VISIBLE_WHERE} order by d.updated_at desc`,
    [req.user!.tenant, req.user!.email, req.user!.roles.includes('admin')],
  )).rows
  res.json({ dashboards: rows.map(toSummary) })
})

dashboardsRouter.post('/', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { name, description } = req.body ?? {}
  if (!name) return res.status(400).json({ error: 'Informe o nome do dashboard.' })
  const row = (await db.query(
    `insert into dashboards (tenant_id, name, description, owner_email)
     select t.id, $1, $2, $3 from tenants t where t.slug = $4 returning id`,
    [String(name).trim(), String(description || ''), req.user!.email, req.user!.tenant],
  )).rows[0]
  await audit(req, 'dashboards.create', { type: 'dashboard', id: String(row.id) }, { name })
  res.status(201).json({ id: row.id })
})

dashboardsRouter.get('/:id', requireAuth(), requireDb, async (req, res) => {
  const row = (await db.query(
    `select d.*, (select count(*) from widgets w where w.dashboard_id = d.id) as widget_count
       from dashboards d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.id = $4 and ${VISIBLE_WHERE}`,
    [req.user!.tenant, req.user!.email, req.user!.roles.includes('admin'), req.params.id],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Dashboard não encontrado.' })
  const widgets = (await db.query(
    `select w.*, ds.slug as dataset_slug from widgets w
      join datasets ds on ds.id = w.dataset_id
     where w.dashboard_id = $1 order by w.sort_order, w.created_at`,
    [req.params.id],
  )).rows
  res.json({ dashboard: { ...toSummary(row), widgets: widgets.map(toWidget) } })
})

dashboardsRouter.patch('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { name, description, visibility } = req.body ?? {}
  await db.query(
    `update dashboards set name = coalesce($2, name), description = coalesce($3, description),
       visibility = coalesce($4, visibility), updated_at = now() where id = $1`,
    [req.params.id, name ?? null, description ?? null,
     ['tenant', 'private'].includes(visibility) ? visibility : null],
  )
  res.json({ ok: true })
})

// ── Compartilhamento ───────────────────────────────────────────
dashboardsRouter.get('/:id/shares', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(
    `select d.visibility,
            coalesce(json_agg(json_build_object('id', g.id, 'email', g.grantee_email, 'level', g.level))
              filter (where g.id is not null), '[]') as grants
       from dashboards d left join dashboard_grants g on g.dashboard_id = d.id
      where d.id = $1 group by d.id`,
    [req.params.id],
  )).rows[0]
  if (!rows) return res.status(404).json({ error: 'Dashboard não encontrado.' })
  res.json({ visibility: rows.visibility, grants: rows.grants })
})

dashboardsRouter.post('/:id/shares', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode compartilhar.' })
  const { email, level } = req.body ?? {}
  if (!email || !/@/.test(String(email))) return res.status(400).json({ error: 'Informe o e-mail do convidado.' })
  await db.query(
    `insert into dashboard_grants (dashboard_id, grantee_email, level, created_by)
     values ($1, $2, $3, $4)
     on conflict (dashboard_id, grantee_email) do update set level = excluded.level`,
    [req.params.id, String(email).toLowerCase().trim(), level === 'edit' ? 'edit' : 'view', req.user!.email],
  )
  await audit(req, 'dashboards.share', { type: 'dashboard', id: req.params.id }, { email, level })
  res.status(201).json({ ok: true })
})

dashboardsRouter.delete('/:id/shares/:grantId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode compartilhar.' })
  await db.query(`delete from dashboard_grants where id = $2 and dashboard_id = $1`, [req.params.id, req.params.grantId])
  res.json({ ok: true })
})

dashboardsRouter.delete('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode excluir.' })
  await db.query('delete from dashboards where id = $1', [req.params.id])
  await audit(req, 'dashboards.delete', { type: 'dashboard', id: req.params.id })
  res.json({ ok: true })
})

// ── Widgets ────────────────────────────────────────────────────
dashboardsRouter.post('/:id/widgets', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { title, type, datasetId, dimension, metric, filters, size } = req.body ?? {}
  if (!TYPES.has(type)) return res.status(400).json({ error: `Tipo inválido: ${type}` })
  if (!datasetId || !metric) return res.status(400).json({ error: 'datasetId e metric são obrigatórios.' })
  if (type !== 'kpi' && !dimension) return res.status(400).json({ error: 'Gráficos precisam de uma dimensão (campo do eixo).' })

  const row = (await db.query(
    `insert into widgets (dashboard_id, dataset_id, title, type, dimension, metric, filters, size, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8,
       coalesce((select max(sort_order) + 1 from widgets where dashboard_id = $1), 0))
     returning id`,
    [req.params.id, datasetId, String(title || ''), type, dimension ?? null,
     JSON.stringify(metric), JSON.stringify(filters ?? []), SIZES.has(size) ? size : 'md'],
  )).rows[0]
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.status(201).json({ id: row.id })
})

dashboardsRouter.patch('/:id/widgets/:widgetId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { title, size, sortOrder } = req.body ?? {}
  const row = (await db.query(
    `update widgets set
       title = coalesce($3, title),
       size = coalesce($4, size),
       sort_order = coalesce($5, sort_order),
       updated_at = now()
     where id = $2 and dashboard_id = $1 returning id`,
    [req.params.id, req.params.widgetId, title ?? null,
     SIZES.has(size) ? size : null, Number.isInteger(sortOrder) ? sortOrder : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Widget não encontrado.' })
  res.json({ ok: true })
})

dashboardsRouter.delete('/:id/widgets/:widgetId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  await db.query('delete from widgets where id = $2 and dashboard_id = $1', [req.params.id, req.params.widgetId])
  res.json({ ok: true })
})
