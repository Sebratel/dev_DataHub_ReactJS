// Dashboards e widgets. Todos do tenant veem; editores criam; dono ou admin
// edita/apaga. O dado do widget vem do endpoint de query (o widget só guarda
// a definição: dataset + dimensão + métrica + filtros).
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { DashboardSummary, Widget, QueryFilter, DashboardTab } from '@datahub/shared'
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
    settings: (row.settings ?? null) as DashboardSummary['settings'],
  }
}

function toWidget(row: Record<string, unknown>): Widget {
  return {
    id: String(row.id), tabId: row.tab_id ? String(row.tab_id) : '',
    title: String(row.title ?? ''), type: row.type as Widget['type'],
    datasetId: String(row.dataset_id), datasetSlug: String(row.dataset_slug),
    dimension: (row.dimension as string) ?? null,
    metric: row.metric as Widget['metric'],
    filters: (row.filters ?? []) as QueryFilter[],
    size: row.size as Widget['size'], sortOrder: Number(row.sort_order),
    layout: (row.layout ?? null) as Widget['layout'],
    style: (row.style ?? null) as Widget['style'],
  }
}

function toTab(row: Record<string, unknown>): DashboardTab {
  return {
    id: String(row.id), label: String(row.label ?? 'Geral'),
    icon: (row.icon as string) ?? null, sortOrder: Number(row.sort_order ?? 0),
    config: (row.config ?? null) as DashboardTab['config'],
  }
}

// Dono, admin ou convidado (por e-mail OU por time) com level 'edit' pode mexer.
async function canEdit(req: Request, dashboardId: string): Promise<boolean> {
  if (req.user!.roles.includes('admin')) return true
  const row = (await db.query('select owner_email from dashboards where id = $1', [dashboardId])).rows[0]
  if (row && row.owner_email === req.user!.email) return true
  const grant = (await db.query(
    `select 1 from dashboard_grants g
      where g.dashboard_id = $1 and g.level = 'edit' and (
        g.grantee_email = $2
        or g.team_id in (select team_id from team_members where user_email = $2))`,
    [dashboardId, req.user!.email],
  )).rows[0]
  return !!grant
}

// Visível se: visibilidade 'tenant', OU dono, OU admin, OU convidado por
// e-mail, OU membro de um time com concessão.
const VISIBLE_WHERE = `(d.visibility = 'tenant' or d.owner_email = $2 or $3
  or exists (select 1 from dashboard_grants g where g.dashboard_id = d.id and g.grantee_email = $2)
  or exists (select 1 from dashboard_grants g join team_members m on m.team_id = g.team_id
             where g.dashboard_id = d.id and m.user_email = $2))`

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
  // Todo dashboard nasce com uma aba "Geral" (o modelo novo exige ao menos uma).
  await db.query(`insert into dashboard_tabs (dashboard_id, label, sort_order) values ($1, 'Geral', 0)`, [row.id])
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
  // Garante ao menos uma aba (dashboards criados antes da migração já têm a
  // "Geral" pelo backfill; esta é uma rede de segurança para casos raros).
  let tabs = (await db.query(
    `select * from dashboard_tabs where dashboard_id = $1 order by sort_order, created_at`, [req.params.id],
  )).rows
  if (tabs.length === 0) {
    await db.query(`insert into dashboard_tabs (dashboard_id, label, sort_order) values ($1, 'Geral', 0)`, [req.params.id])
    await db.query(`update widgets set tab_id = (select id from dashboard_tabs where dashboard_id = $1 limit 1) where dashboard_id = $1 and tab_id is null`, [req.params.id])
    tabs = (await db.query(`select * from dashboard_tabs where dashboard_id = $1 order by sort_order`, [req.params.id])).rows
  }
  const widgets = (await db.query(
    `select w.*, ds.slug as dataset_slug from widgets w
      join datasets ds on ds.id = w.dataset_id
     where w.dashboard_id = $1 order by w.sort_order, w.created_at`,
    [req.params.id],
  )).rows
  res.json({ dashboard: { ...toSummary(row), tabs: tabs.map(toTab), widgets: widgets.map(toWidget) } })
})

dashboardsRouter.patch('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { name, description, visibility, settings } = req.body ?? {}
  await db.query(
    `update dashboards set name = coalesce($2, name), description = coalesce($3, description),
       visibility = coalesce($4, visibility),
       settings = case when $5::jsonb is not null then $5::jsonb else settings end,
       updated_at = now() where id = $1`,
    [req.params.id, name ?? null, description ?? null,
     ['tenant', 'private'].includes(visibility) ? visibility : null,
     settings != null ? JSON.stringify(settings) : null],
  )
  res.json({ ok: true })
})

// ── Compartilhamento (por TIME ou por PESSOA) ──────────────────
dashboardsRouter.get('/:id/shares', requireAuth(), requireDb, async (req, res) => {
  const dash = (await db.query('select id, visibility from dashboards where id = $1', [req.params.id])).rows[0]
  if (!dash) return res.status(404).json({ error: 'Dashboard não encontrado.' })
  const grants = (await db.query(
    `select g.id, g.team_id, g.grantee_email, g.level, tm.name as team_name
       from dashboard_grants g left join teams tm on tm.id = g.team_id
      where g.dashboard_id = $1 order by g.created_at`,
    [req.params.id],
  )).rows.map((g) => ({
    id: String(g.id),
    teamId: g.team_id ? String(g.team_id) : null,
    teamName: g.team_name ?? null,
    email: g.grantee_email ?? null,
    level: g.level as 'view' | 'edit',
  }))
  const teams = (await db.query(
    `select id, name from teams where tenant_id = (select id from tenants where slug = $1) order by name`,
    [req.user!.tenant],
  )).rows.map((t) => ({ id: String(t.id), name: String(t.name) }))
  res.json({ visibility: dash.visibility, teams, grants })
})

dashboardsRouter.post('/:id/shares', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode compartilhar.' })
  const { teamId, email, level } = req.body ?? {}
  const lvl = level === 'edit' ? 'edit' : 'view'
  const hasTeam = !!teamId
  const hasEmail = !!email
  if (hasTeam === hasEmail) return res.status(400).json({ error: 'Informe exatamente um: teamId OU email.' })

  if (hasTeam) {
    const ok = (await db.query(
      'select 1 from teams where id = $1 and tenant_id = (select id from tenants where slug = $2)',
      [teamId, req.user!.tenant],
    )).rows[0]
    if (!ok) return res.status(400).json({ error: 'Time não encontrado neste tenant.' })
    await db.query(
      `insert into dashboard_grants (dashboard_id, team_id, level, created_by)
       values ($1, $2, $3, $4)
       on conflict (dashboard_id, team_id) where team_id is not null do update set level = excluded.level`,
      [req.params.id, String(teamId), lvl, req.user!.email],
    )
  } else {
    if (!/@/.test(String(email))) return res.status(400).json({ error: 'Informe um e-mail válido.' })
    await db.query(
      `insert into dashboard_grants (dashboard_id, grantee_email, level, created_by)
       values ($1, $2, $3, $4)
       on conflict (dashboard_id, grantee_email) do update set level = excluded.level`,
      [req.params.id, String(email).toLowerCase().trim(), lvl, req.user!.email],
    )
  }
  await audit(req, 'dashboards.share', { type: 'dashboard', id: req.params.id }, { teamId: teamId ?? null, email: email ?? null, level: lvl })
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

// ── Abas ───────────────────────────────────────────────────────
// Cada dashboard tem N abas (guias). Deletar uma aba apaga seus widgets
// (cascade); o dashboard nunca fica sem aba.
dashboardsRouter.post('/:id/tabs', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { label, icon } = req.body ?? {}
  const row = (await db.query(
    `insert into dashboard_tabs (dashboard_id, label, icon, sort_order)
     values ($1, $2, $3, coalesce((select max(sort_order) + 1 from dashboard_tabs where dashboard_id = $1), 0))
     returning *`,
    [req.params.id, String(label || 'Nova aba').trim().slice(0, 60), icon ?? null],
  )).rows[0]
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.status(201).json({ tab: toTab(row) })
})

dashboardsRouter.patch('/:id/tabs/:tabId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { label, icon, sortOrder, config } = req.body ?? {}
  const row = (await db.query(
    `update dashboard_tabs set
       label = coalesce($3, label), icon = coalesce($4, icon),
       sort_order = coalesce($5, sort_order),
       config = case when $6::jsonb is not null then $6::jsonb else config end
     where id = $2 and dashboard_id = $1 returning *`,
    [req.params.id, req.params.tabId,
     label != null ? String(label).trim().slice(0, 60) : null, icon ?? null,
     Number.isInteger(sortOrder) ? sortOrder : null,
     config != null ? JSON.stringify(config) : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Aba não encontrada.' })
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.json({ tab: toTab(row) })
})

dashboardsRouter.delete('/:id/tabs/:tabId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const count = Number((await db.query('select count(*) as n from dashboard_tabs where dashboard_id = $1', [req.params.id])).rows[0].n)
  if (count <= 1) return res.status(400).json({ error: 'O dashboard precisa de ao menos uma aba.' })
  await db.query('delete from dashboard_tabs where id = $2 and dashboard_id = $1', [req.params.id, req.params.tabId])
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.json({ ok: true })
})

// ── Widgets ────────────────────────────────────────────────────
dashboardsRouter.post('/:id/widgets', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { title, type, datasetId, dimension, metric, filters, size, tabId, layout, style } = req.body ?? {}
  if (!TYPES.has(type)) return res.status(400).json({ error: `Tipo inválido: ${type}` })
  if (!datasetId || !metric) return res.status(400).json({ error: 'datasetId e metric são obrigatórios.' })
  if (type !== 'kpi' && !dimension) return res.status(400).json({ error: 'Gráficos precisam de uma dimensão (campo do eixo).' })

  // Aba de destino: a informada (validando que é do dashboard) ou a primeira.
  const tab = (await db.query(
    `select id from dashboard_tabs where dashboard_id = $1 and ($2::uuid is null or id = $2) order by sort_order limit 1`,
    [req.params.id, tabId ?? null],
  )).rows[0]
  if (!tab) return res.status(400).json({ error: 'Aba de destino inválida.' })

  const row = (await db.query(
    `insert into widgets (dashboard_id, tab_id, dataset_id, title, type, dimension, metric, filters, size, layout, style, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       coalesce((select max(sort_order) + 1 from widgets where dashboard_id = $1), 0))
     returning id`,
    [req.params.id, tab.id, datasetId, String(title || ''), type, dimension ?? null,
     JSON.stringify(metric), JSON.stringify(filters ?? []), SIZES.has(size) ? size : 'md',
     layout ? JSON.stringify(layout) : null, style ? JSON.stringify(style) : null],
  )).rows[0]
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.status(201).json({ id: row.id })
})

dashboardsRouter.patch('/:id/widgets/:widgetId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const { title, size, sortOrder, type, datasetId, dimension, metric, filters, tabId, layout, style } = req.body ?? {}
  // Edição de CONFIG (tipo/dataset/dimensão/métrica) só quando `type` é enviado;
  // os PATCHes de resize/reorder/título/layout/estilo continuam funcionando sem isso.
  if (type !== undefined) {
    if (!TYPES.has(type)) return res.status(400).json({ error: `Tipo inválido: ${type}` })
    if (!datasetId || !metric) return res.status(400).json({ error: 'datasetId e metric são obrigatórios.' })
    if (type !== 'kpi' && !dimension) return res.status(400).json({ error: 'Gráficos precisam de uma dimensão (campo do eixo).' })
  }
  const row = (await db.query(
    `update widgets set
       title = coalesce($3, title),
       size = coalesce($4, size),
       sort_order = coalesce($5, sort_order),
       type = coalesce($6, type),
       dataset_id = coalesce($7, dataset_id),
       dimension = case when $6::text is not null then $8 else dimension end,
       metric = coalesce($9, metric),
       filters = coalesce($10, filters),
       tab_id = coalesce($11, tab_id),
       layout = case when $12::jsonb is not null then $12::jsonb else layout end,
       style = case when $13::jsonb is not null then $13::jsonb else style end,
       updated_at = now()
     where id = $2 and dashboard_id = $1 returning id`,
    [req.params.id, req.params.widgetId, title ?? null,
     SIZES.has(size) ? size : null, Number.isInteger(sortOrder) ? sortOrder : null,
     type ?? null, datasetId ?? null,
     type ? (type === 'kpi' ? null : dimension) : null,
     metric ? JSON.stringify(metric) : null,
     filters ? JSON.stringify(filters) : null,
     tabId ?? null,
     layout !== undefined ? JSON.stringify(layout) : null,
     style !== undefined ? JSON.stringify(style) : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Widget não encontrado.' })
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.json({ ok: true })
})

// Salvamento em lote do layout do grid (após arrastar/redimensionar). Aceita
// [{ id, layout:{x,y,w,h}, tabId? }] e persiste tudo numa tacada — evita N
// requisições e o "pisca" de recarregar o dashboard a cada movimento.
dashboardsRouter.put('/:id/layout', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  const items = Array.isArray(req.body?.widgets) ? req.body.widgets : []
  for (const it of items) {
    if (!it?.id || !it?.layout) continue
    const { x, y, w, h } = it.layout
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue
    await db.query(
      `update widgets set layout = $3::jsonb, tab_id = coalesce($4, tab_id), updated_at = now()
       where id = $2 and dashboard_id = $1`,
      [req.params.id, it.id, JSON.stringify({ x, y, w, h }), it.tabId ?? null],
    )
  }
  await db.query('update dashboards set updated_at = now() where id = $1', [req.params.id])
  res.json({ ok: true })
})

dashboardsRouter.delete('/:id/widgets/:widgetId', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  if (!(await canEdit(req, req.params.id))) return res.status(403).json({ error: 'Apenas o dono (ou admin) pode editar.' })
  await db.query('delete from widgets where id = $2 and dashboard_id = $1', [req.params.id, req.params.widgetId])
  res.json({ ok: true })
})
