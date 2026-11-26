// Plano de CONTROLE do gateway: cadastro dos upstreams, fila de aprovação e
// consumo por credencial. Mesma regra dos produtos de API — editor cria e fica
// pendente; admin cria já aprovado e é quem aprova o dos outros.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { hasSecret } from '../../core/crypto.js'
import { currentSlugFor } from '../../core/slugAliases.js'
import { diaLocal, diaLocalDe } from '../../core/usage.js'
import type { GatewayDatasetUsage, GatewayDatasetsOverview } from '@datahub/shared'
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

// Editar um upstream APROVADO mudando endereço, credencial ou métodos o devolve
// para a fila quando quem edita não é admin (SEG-04). A resposta diz o que
// motivou, para a tela explicar por que ele saiu do ar.
gatewayRouter.put('/upstreams/:id', ...editorOnly, async (req, res) => {
  try {
    const { upstream: up, reaprovar } = await updateUpstream(
      req.user!.tenant, req.params.id, req.body as UpstreamInput,
      { email: req.user!.email, admin: req.user!.roles.includes('admin') },
    )
    await audit(req, 'gateway.upstream.update', { type: 'upstream', id: up.id },
      { slug: up.slug, baseUrl: up.baseUrl, status: up.status, reaprovar })
    res.json({ upstream: up, reaprovar })
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
       where c.id = $1 and c.tenant_id = (select id from tenants where slug = $2)
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

// Conjuntos usados POR FORA, consolidados (pedido de 26/11/2026). Antes, para
// saber "quem lê este conjunto pela API?" era preciso abrir API por API e token
// por token. Aqui, por conjunto:
//   • quem PODE ler: APIs de leitura (/p) ativas e tokens com ele no escopo;
//   • quem LEU: leituras por token nos últimos 30 dias (usage_daily, via 'api',
//     só as que deram certo — gravado desde o MON-01).
// Token sem escopo lê TODOS os conjuntos: vai numa lista à parte, senão todo
// conjunto do catálogo apareceria como "exposto". Só admin: mostra tokens
// (D-SEG-3 / T-SEG-09).
gatewayRouter.get('/datasets', ...adminOnly, async (req, res) => {
  const tenant = req.user!.tenant
  const conjuntos = (await db.query(
    `select d.id, d.slug, d.name, d.official from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1`,
    [tenant],
  )).rows
  const porSlug = new Map(conjuntos.map((d) => [String(d.slug), d]))
  const porId = new Map(conjuntos.map((d) => [String(d.id), d]))
  // Escopo e API gravados com o nome antigo de um conjunto renomeado continuam valendo.
  const acha = (s: string) => porSlug.get(s) ?? porSlug.get(currentSlugFor(s) ?? '')

  const agora = Date.now()
  const tokens = (await db.query(
    `select c.id, c.name, c.revoked, c.expires_at, c.dataset_slugs from api_credentials c
       join tenants t on t.id = c.tenant_id where t.slug = $1`,
    [tenant],
  )).rows
  const ativo = (c: Record<string, any>) => !c.revoked && !(c.expires_at && new Date(c.expires_at).getTime() < agora)
  const nomeToken = new Map(tokens.map((c) => [`token:${c.id}`, String(c.name)]))

  const apis = (await db.query(
    `select p.slug, p.name, p.dataset_slug from api_products p join tenants t on t.id = p.tenant_id
      where t.slug = $1 and p.kind = 'read' and p.status = 'active' and p.enabled and p.dataset_slug is not null`,
    [tenant],
  )).rows

  const desde = diaLocal(-30)
  const uso = (await db.query(
    `select u.resource_id, u.actor, sum(u.hits) as hits, max(u.last_at) as last_at
       from usage_daily u join tenants t on t.id = u.tenant_id
      where t.slug = $1 and u.resource_type = 'dataset' and u.via = 'api' and u.day > $2::date
      group by u.resource_id, u.actor`,
    [tenant, desde],
  )).rows
  const ultimaLeitura = new Map((await db.query(
    `select u.resource_id, max(u.last_at) as last_at
       from usage_daily u join tenants t on t.id = u.tenant_id
      where t.slug = $1 and u.resource_type = 'dataset' and u.via = 'api'
      group by u.resource_id`,
    [tenant],
  )).rows.map((r) => [String(r.resource_id), r.last_at]))
  const registroDesde = (await db.query(
    `select min(u.day) as d from usage_daily u join tenants t on t.id = u.tenant_id where t.slug = $1 and u.via = 'api'`,
    [tenant],
  )).rows[0]?.d ?? null

  const linhas = new Map<string, GatewayDatasetUsage>()
  const linha = (d: Record<string, any>) => {
    const id = String(d.id)
    let l = linhas.get(id)
    if (!l) {
      l = {
        id, slug: String(d.slug), name: String(d.name), official: !!d.official,
        apis: [], tokens: [], calls30d: 0, consumers30d: [], lastReadAt: null,
      }
      linhas.set(id, l)
    }
    return l
  }
  for (const p of apis) {
    const d = acha(String(p.dataset_slug))
    if (d) linha(d).apis.push({ slug: String(p.slug), name: String(p.name) })
  }
  const tudo: { id: string; name: string }[] = []
  for (const c of tokens) {
    if (!ativo(c)) continue
    const escopo = (c.dataset_slugs as string[] | null) ?? []
    if (!escopo.length) { tudo.push({ id: String(c.id), name: String(c.name) }); continue }
    for (const s of new Set(escopo)) {
      const d = acha(s)
      if (d && !linha(d).tokens.some((x) => x.id === String(c.id))) linha(d).tokens.push({ id: String(c.id), name: String(c.name) })
    }
  }
  const quem = new Map<string, Map<string, number>>()
  for (const u of uso) {
    const d = porId.get(String(u.resource_id))
    if (!d) continue // conjunto excluído: o histórico fica, a linha não
    const l = linha(d)
    l.calls30d += Number(u.hits)
    const nome = nomeToken.get(String(u.actor)) ?? 'token excluído'
    const m = quem.get(l.id) ?? new Map<string, number>()
    m.set(nome, (m.get(nome) ?? 0) + Number(u.hits))
    quem.set(l.id, m)
  }
  for (const l of linhas.values()) {
    const ult = ultimaLeitura.get(l.id)
    l.lastReadAt = ult ? new Date(ult).toISOString() : null
    l.consumers30d = [...(quem.get(l.id) ?? new Map()).entries()]
      .map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls)
  }
  const body: GatewayDatasetsOverview = {
    trackingSince: registroDesde ? String(registroDesde instanceof Date ? diaLocalDe(registroDesde) : registroDesde).slice(0, 10) : null,
    allAccessTokens: tudo,
    datasets: [...linhas.values()].sort((a, b) => b.calls30d - a.calls30d || a.name.localeCompare(b.name, 'pt-BR')),
  }
  res.json(body)
})

// Consumo do dia por token. Só admin: lista o nome, a cota e o limite de cada
// token, e token é assunto só de admin (D-SEG-3 / T-SEG-09).
gatewayRouter.get('/usage', ...adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.name, c.rate_limit_per_min, c.quota_per_day, c.upstream_slugs,
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
