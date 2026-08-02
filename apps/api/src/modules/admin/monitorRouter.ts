// Admin › Monitoramento — CRUD dos HEALTH CHECKS (Fase 3). O tick a cada 60s
// (scheduler) executa os vencidos e grava em api_call_metrics. Aqui só gerência.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const monitorRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
monitorRouter.use(requireAuth({ role: 'admin' }), requireDb)

function parse(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const name = String(b.name ?? '').trim()
  const url = String(b.url ?? '').trim()
  if (!name) throw new Error('Informe o nome.')
  if (!/^https?:\/\//i.test(url)) throw new Error('Informe uma URL válida (http:// ou https://).')
  const interval = Math.max(1, Number(b.intervalMinutes) || 5)
  return {
    name, url, interval,
    connectionId: b.connectionId ? String(b.connectionId) : null,
    enabled: b.enabled !== false,
  }
}

// Lista os checks do tenant + o último resultado (do painel de métricas).
monitorRouter.get('/', async (req, res) => {
  const rows = (await db.query(
    `select h.id, h.name, h.url, h.connection_id, h.interval_minutes, h.enabled, h.last_run_at,
            (select json_build_object('ok', m.ok, 'status', m.status, 'ms', m.duration_ms, 'at', m.created_at)
               from api_call_metrics m
              where m.check_type = 'healthcheck' and m.endpoint = h.url
              order by m.created_at desc limit 1) as last
       from health_checks h join tenants t on t.id = h.tenant_id
      where t.slug = $1 order by h.created_at`,
    [req.user!.tenant],
  )).rows
  res.json({ checks: rows })
})

monitorRouter.post('/', async (req, res) => {
  try {
    const p = parse(req.body)
    const row = (await db.query(
      `insert into health_checks (tenant_id, name, url, connection_id, interval_minutes, enabled, created_by)
       select t.id, $2, $3, $4, $5, $6, $7 from tenants t where t.slug = $1 returning id`,
      [req.user!.tenant, p.name, p.url, p.connectionId, p.interval, p.enabled, req.user!.email],
    )).rows[0]
    await audit(req, 'monitor.create', { type: 'health_check', id: String(row.id) }, { url: p.url })
    res.status(201).json({ id: row.id })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

monitorRouter.patch('/:id', async (req, res) => {
  try {
    const p = parse(req.body)
    const row = (await db.query(
      `update health_checks h set name=$3, url=$4, connection_id=$5, interval_minutes=$6, enabled=$7
         from tenants t
        where h.tenant_id = t.id and t.slug = $1 and h.id = $2 returning h.id`,
      [req.user!.tenant, req.params.id, p.name, p.url, p.connectionId, p.interval, p.enabled],
    )).rows[0]
    if (!row) return res.status(404).json({ error: 'Verificação não encontrada.' })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

monitorRouter.delete('/:id', async (req, res) => {
  await db.query(
    `delete from health_checks h using tenants t
      where h.tenant_id = t.id and t.slug = $1 and h.id = $2`,
    [req.user!.tenant, req.params.id],
  )
  await audit(req, 'monitor.delete', { type: 'health_check', id: req.params.id })
  res.json({ ok: true })
})
