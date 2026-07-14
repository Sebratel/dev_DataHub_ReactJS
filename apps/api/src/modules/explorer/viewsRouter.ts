// Visualizações salvas do Explorador. Qualquer usuário autenticado cria as
// suas; vê as próprias + as compartilhadas do tenant; só o dono (ou admin)
// altera/apaga.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { SavedView, ViewDefinition } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const viewsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const authed = [requireAuth(), requireDb]

function toView(row: Record<string, unknown>): SavedView {
  return {
    id: String(row.id),
    name: String(row.name),
    definition: (row.definition ?? {}) as ViewDefinition,
    ownerEmail: String(row.owner_email),
    shared: !!row.shared,
    updatedAt: String(row.updated_at),
  }
}

viewsRouter.get('/:datasetId/views', ...authed, async (req, res) => {
  const rows = (await db.query(
    `select v.* from saved_views v
      where v.dataset_id = $1 and (v.owner_email = $2 or v.shared)
      order by v.updated_at desc`,
    [req.params.datasetId, req.user!.email],
  )).rows
  res.json({ views: rows.map(toView) })
})

viewsRouter.post('/:datasetId/views', ...authed, async (req, res) => {
  const { name, definition, shared } = req.body ?? {}
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Informe um nome para a visualização.' })
  const row = (await db.query(
    `insert into saved_views (tenant_id, dataset_id, name, definition, owner_email, shared)
     select t.id, $1, $2, $3, $4, $5 from tenants t where t.slug = $6
     returning *`,
    [req.params.datasetId, name.trim(), JSON.stringify(definition ?? {}), req.user!.email, !!shared, req.user!.tenant],
  )).rows[0]
  await audit(req, 'views.create', { type: 'view', id: String(row.id) }, { name })
  res.status(201).json({ view: toView(row) })
})

viewsRouter.patch('/:datasetId/views/:viewId', ...authed, async (req, res) => {
  const { name, definition, shared } = req.body ?? {}
  const admin = req.user!.roles.includes('admin')
  const row = (await db.query(
    `update saved_views set
       name = coalesce($3, name),
       definition = coalesce($4, definition),
       shared = coalesce($5, shared),
       updated_at = now()
     where id = $2 and dataset_id = $1 ${admin ? '' : 'and owner_email = $6'}
     returning *`,
    admin
      ? [req.params.datasetId, req.params.viewId, name ?? null, definition ? JSON.stringify(definition) : null, typeof shared === 'boolean' ? shared : null]
      : [req.params.datasetId, req.params.viewId, name ?? null, definition ? JSON.stringify(definition) : null, typeof shared === 'boolean' ? shared : null, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Visualização não encontrada (ou você não é o dono).' })
  res.json({ view: toView(row) })
})

viewsRouter.delete('/:datasetId/views/:viewId', ...authed, async (req, res) => {
  const admin = req.user!.roles.includes('admin')
  const row = (await db.query(
    `delete from saved_views where id = $2 and dataset_id = $1 ${admin ? '' : 'and owner_email = $3'} returning name`,
    admin ? [req.params.datasetId, req.params.viewId] : [req.params.datasetId, req.params.viewId, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Visualização não encontrada (ou você não é o dono).' })
  await audit(req, 'views.delete', { type: 'view', id: req.params.viewId }, { name: row.name })
  res.json({ ok: true })
})
