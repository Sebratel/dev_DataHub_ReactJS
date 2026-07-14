// Auth: Bearer <google_access_token> validado no userinfo do Google, com cache
// curto (padrão validado no churn_mvp). No primeiro login o usuário é criado no
// tenant padrão; e-mails em ADMIN_EMAILS ganham papel admin, demais viewer.
// Se o banco de metadados estiver fora, autentica só pelo domínio (degradado).
import type { Request, Response, NextFunction } from 'express'
import type { SessionUser } from '@datahub/shared'
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'

const tokenCache = new Map<string, { user: SessionUser; exp: number }>()
const TOKEN_TTL_MS = 5 * 60 * 1000

interface GoogleProfile {
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

async function fetchGoogleProfile(token: string): Promise<GoogleProfile | null> {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) return null
  return (await r.json()) as GoogleProfile
}

// Cria/atualiza o usuário no tenant padrão e devolve seus papéis.
async function provisionUser(p: { email: string; name: string; picture?: string }): Promise<SessionUser> {
  if (!isDbAvailable()) {
    return { ...p, roles: config.adminEmails.includes(p.email) ? ['admin'] : ['viewer'], tenant: 'sebratel' }
  }
  const tenant = (await db.query(`select id, slug from tenants where slug = 'sebratel'`)).rows[0]
  const user = (await db.query(
    `insert into users (tenant_id, email, name, picture, last_login_at)
     values ($1, $2, $3, $4, now())
     on conflict (email) do update
       set name = excluded.name, picture = excluded.picture, last_login_at = now(), updated_at = now()
     returning id`,
    [tenant.id, p.email, p.name, p.picture ?? null],
  )).rows[0]

  const defaultRole = config.adminEmails.includes(p.email) ? 'admin' : 'viewer'
  await db.query(
    `insert into user_roles (user_id, role_id)
     select $1, r.id from roles r where r.tenant_id = $2 and r.name = $3
     on conflict do nothing`,
    [user.id, tenant.id, defaultRole],
  )
  const roles = (await db.query(
    `select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
    [user.id],
  )).rows.map((r) => r.name as string)

  return { email: p.email, name: p.name, picture: p.picture, roles, tenant: tenant.slug }
}

async function getUserFromToken(token: string): Promise<SessionUser | null> {
  const cached = tokenCache.get(token)
  if (cached && cached.exp > Date.now()) return cached.user

  const p = await fetchGoogleProfile(token)
  if (!p?.email || p.email_verified === false) return null
  const email = p.email.toLowerCase()
  if (!email.endsWith('@' + config.allowedDomain)) return null

  const user = await provisionUser({ email, name: p.name || email, picture: p.picture })
  tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS })
  return user
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
  }
}

export function requireAuth({ role }: { role?: 'admin' | 'editor' } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) return res.status(401).json({ error: 'Token de autenticação ausente.' })
    let user: SessionUser | null = null
    try { user = await getUserFromToken(m[1]) } catch { user = null }
    if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })
    if (role === 'admin' && !user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta ação.' })
    }
    if (role === 'editor' && !user.roles.some((r) => r === 'admin' || r === 'editor')) {
      return res.status(403).json({ error: 'Sua conta não tem permissão de edição.' })
    }
    req.user = user
    next()
  }
}

// Auditoria best-effort — nunca derruba a request.
export async function audit(req: Request, action: string, resource?: { type: string; id: string }, detail?: unknown): Promise<void> {
  if (!isDbAvailable()) return
  try {
    await db.query(
      `insert into audit_logs (tenant_id, user_email, action, resource_type, resource_id, detail, ip)
       select t.id, $1, $2, $3, $4, $5, $6 from tenants t where t.slug = $7`,
      [req.user?.email ?? null, action, resource?.type ?? null, resource?.id ?? null,
       detail ? JSON.stringify(detail) : null, req.ip, req.user?.tenant ?? 'sebratel'],
    )
  } catch (e) {
    console.warn(`[audit] falha ao registrar "${action}": ${(e as Error).message}`)
  }
}
