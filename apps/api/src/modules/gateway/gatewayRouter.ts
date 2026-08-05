// Plano de CONTROLE do gateway: cadastro dos upstreams, fila de aprovação e
// consumo por credencial. Mesma regra dos produtos de API — editor cria e fica
// pendente; admin cria já aprovado e é quem aprova o dos outros.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { hasSecret } from '../../core/crypto.js'
import {
  listUpstreams, createUpstream, updateUpstream, reviewUpstream,
  setUpstreamEnabled, deleteUpstream, type UpstreamInput,
} from './upstreams.js'

export const gatewayRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

const editorOnly = [requireAuth({ role: 'editor' }), requireDb]
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]

const fail = (res: Response, e: unknown) =>
  res.status(400).json({ error: (e as Error).message })

// ── Upstreams ────────────────────────────────────────────────────────────
gatewayRouter.get('/upstreams', ...editorOnly, async (req, res) => {
  res.json({ upstreams: await listUpstreams(req.user!.tenant), secretConfigured: hasSecret() })
})

gatewayRouter.post('/upstreams', ...editorOnly, async (req, res) => {
  const isAdmin = req.user!.roles.includes('admin')
  try {
    const up = await createUpstream(
      req.user!.tenant, req.body as UpstreamInput, req.user!.email, isAdmin,
    )
    await audit(req, 'gateway.upstream.create', { type: 'upstream', id: up.id },
      { slug: up.slug, baseUrl: up.baseUrl, status: up.status })
    res.status(201).json({ upstream: up })
  } catch (e) { fail(res, e) }
})

gatewayRouter.put('/upstreams/:id', ...editorOnly, async (req, res) => {
  try {
    const up = await updateUpstream(req.user!.tenant, req.params.id, req.body as UpstreamInput)
    await audit(req, 'gateway.upstream.update', { type: 'upstream', id: up.id }, { slug: up.slug })
    res.json({ upstream: up })
  } catch (e) { fail(res, e) }
})

// Aprovação: só admin. Um upstream pendente não responde no plano de dados.
gatewayRouter.post('/upstreams/:id/review', ...adminOnly, async (req, res) => {
  const status = req.body?.status === 'active' ? 'active' : 'rejected'
  try {
    const up = await reviewUpstream(req.user!.tenant, req.params.id, status, req.user!.email)
    await audit(req, 'gateway.upstream.review', { type: 'upstream', id: up.id }, { status })
    res.json({ upstream: up })
  } catch (e) { fail(res, e) }
})

gatewayRouter.post('/upstreams/:id/enabled', ...editorOnly, async (req, res) => {
  const enabled = req.body?.enabled !== false
  try {
    await setUpstreamEnabled(req.user!.tenant, req.params.id, enabled)
    await audit(req, 'gateway.upstream.enabled', { type: 'upstream', id: req.params.id }, { enabled })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

gatewayRouter.delete('/upstreams/:id', ...adminOnly, async (req, res) => {
  try {
    await deleteUpstream(req.user!.tenant, req.params.id)
    await audit(req, 'gateway.upstream.delete', { type: 'upstream', id: req.params.id })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

// ── Política por consumidor ──────────────────────────────────────────────
// Limites e escopo de upstream ficam no token, não no upstream: é o consumidor
// que tem contrato, não o serviço de trás.
gatewayRouter.put('/credentials/:id/policy', ...adminOnly, async (req, res) => {
  const { rateLimitPerMin, quotaPerDay, upstreamSlugs } = req.body ?? {}
  const int = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) throw new Error('Os limites devem ser números inteiros positivos (ou vazio para "sem limite").')
    return n
  }
  try {
    const row = (await db.query(
      `update api_credentials c set
         rate_limit_per_min = $3, quota_per_day = $4, upstream_slugs = $5
       from tenants t
       where c.id = $1 and c.tenant_id = t.id and t.slug = $2
       returning c.id, c.name, c.rate_limit_per_min, c.quota_per_day, c.upstream_slugs`,
      [req.params.id, req.user!.tenant, int(rateLimitPerMin), int(quotaPerDay),
       Array.isArray(upstreamSlugs) ? upstreamSlugs : []],
    )).rows[0]
    if (!row) return res.status(404).json({ error: 'Token não encontrado.' })
    await audit(req, 'gateway.credential.policy', { type: 'credential', id: req.params.id },
      { rateLimitPerMin, quotaPerDay, upstreamSlugs })
    res.json({ credential: row })
  } catch (e) { fail(res, e) }
})

// Consumo do dia — alimenta a tela de tokens ("quanto já gastei do meu teto").
gatewayRouter.get('/usage', ...editorOnly, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.name, c.rate_limit_per_min, c.quota_per_day,
            coalesce(u.calls, 0) as calls_today
       from api_credentials c
       join tenants t on t.id = c.tenant_id
       left join api_usage_daily u on u.credential_id = c.id and u.day = current_date
      where t.slug = $1 and not c.revoked
      order by calls_today desc, c.name`,
    [req.user!.tenant],
  )).rows
  res.json({ usage: rows })
})
