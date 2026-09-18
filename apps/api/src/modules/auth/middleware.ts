// Auth: aceita DOIS formatos de credencial no header Bearer, escolhidos pelo
// formato do próprio token:
//
//   ID token do Firebase (JWT, três partes)  → assinatura conferida AQUI, com a
//     chave pública do Google em cache. Não fala com a rede a cada login: é o
//     caminho que continua funcionando quando a saída para o Google está
//     bloqueada, e é o padrão que o HUBBI já usa.
//
//   access_token do Google (opaco)  → validado no userinfo do Google. Caminho
//     original, mantido para não exigir janela de indisponibilidade na virada:
//     enquanto alguém estiver com uma aba antiga aberta, o token dela continua
//     valendo.
//
// Nos dois casos, o e-mail precisa ser do domínio permitido. No primeiro login o
// usuário é criado no tenant padrão; e-mails em ADMIN_EMAILS ganham papel admin,
// demais viewer. Se o banco de metadados estiver fora, autentica só pelo domínio
// (degradado).
import type { Request, Response, NextFunction } from 'express'
import type { SessionUser } from '@datahub/shared'
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { verifyFirebaseIdToken } from './firebaseToken.js'
import { isMaster } from './masterAdmins.js'

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
  // Master vem do AMBIENTE (raiz de confiança) ou de uma concessão feita por
  // outro master na tela — nunca do papel 'admin', que qualquer admin concede
  // a si mesmo. Ver masterAdmins.ts.
  const master = isMaster(p.email)
  if (!isDbAvailable()) {
    return { ...p, roles: config.adminEmails.includes(p.email) ? ['admin'] : ['viewer'], tenant: 'sebratel', master }
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

  return { email: p.email, name: p.name, picture: p.picture, roles, tenant: tenant.slug, master }
}

// Um ID token do Firebase é um JWT: três partes separadas por ponto, a
// primeira decodificando para um cabeçalho JSON com "alg". O access_token do
// Google é opaco e não tem essa forma. É o bastante para escolher o caminho —
// e a validação de cada um é estrita, então um palpite errado só resulta em
// 401, nunca em acesso indevido.
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: unknown }
    return typeof h?.alg === 'string'
  } catch { return false }
}

async function getUserFromToken(token: string): Promise<SessionUser | null> {
  const cached = tokenCache.get(token)
  if (cached && cached.exp > Date.now()) return cached.user

  let email: string
  let name: string | undefined
  let picture: string | undefined

  if (looksLikeJwt(token)) {
    const claims = await verifyFirebaseIdToken(token)
    if (!claims || !claims.emailVerified) return null
    email = claims.email
    name = claims.name
    picture = claims.picture
  } else {
    const p = await fetchGoogleProfile(token)
    if (!p?.email || p.email_verified === false) return null
    email = p.email.toLowerCase()
    name = p.name
    picture = p.picture
  }

  if (!email.endsWith('@' + config.allowedDomain)) return null

  const user = await provisionUser({ email, name: name || email, picture })
  // O cache é por TOKEN, e o do Firebase dura 1h: guardar por 5 min mantém a
  // propagação de mudança de papel igual à do caminho antigo.
  tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS })
  if (tokenCache.size > 1000) {
    const now = Date.now()
    for (const [k, v] of tokenCache) if (v.exp <= now) tokenCache.delete(k)
  }
  return user
}

// Uma mensagem só para as rotas que exigem master. Ela diz QUEM pode e COMO
// mudar isso — um 403 que apenas nega manda a pessoa perguntar no corredor.
export const MASTER_ONLY_MESSAGE =
  'Somente o administrador master pode alterar como as FONTES atualizam (modo, chaves, ' +
  'identidade da linha e cadência). Conjuntos calculados seguem liberados para editores. ' +
  'Um master pode conceder o acesso a outra pessoa em Usuários e Acessos.'

// Descarta o que estiver em cache para um e-mail (ou tudo). Chamado ao
// conceder/revogar master: sem isto, uma revogação só valeria quando o cache
// de token vencesse — até 5 minutos de poder depois de ter sido retirado.
export function invalidateTokenCache(email?: string): void {
  if (!email) { tokenCache.clear(); return }
  const alvo = email.trim().toLowerCase()
  for (const [k, v] of tokenCache) if (v.user.email.toLowerCase() === alvo) tokenCache.delete(k)
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
  }
}

export function requireAuth({ role }: { role?: 'master' | 'admin' | 'editor' } = {}) {
  const mw = async (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers.authorization || ''
    const m = /^Bearer (.+)$/.exec(raw)
    if (!m) {
      // Cabeçalho PRESENTE mas em outro esquema quase sempre significa um proxy
      // na frente (Basic Auth de access list, por exemplo) sobrescrevendo o
      // Authorization que o app enviou. Dizer "ausente" nesse caso mandaria
      // quem depura procurar no lugar errado — foi o que aconteceu.
      if (raw.trim()) {
        const esquema = raw.split(' ')[0].slice(0, 20)
        return res.status(401).json({
          error: `Cabeçalho Authorization chegou como "${esquema}", não "Bearer". ` +
            'Um proxy à frente (autenticação básica de access list) provavelmente está ' +
            'substituindo o cabeçalho que o aplicativo envia.',
        })
      }
      return res.status(401).json({ error: 'Token de autenticação ausente.' })
    }
    let user: SessionUser | null = null
    try { user = await getUserFromToken(m[1]) } catch { user = null }
    if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })
    if (role === 'master' && !user.master) {
      return res.status(403).json({ error: MASTER_ONLY_MESSAGE })
    }
    if (role === 'admin' && !user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta ação.' })
    }
    if (role === 'editor' && !user.roles.some((r) => r === 'admin' || r === 'editor')) {
      return res.status(403).json({ error: 'Sua conta não tem permissão de edição.' })
    }
    req.user = user
    next()
  }
  // Nome legível no lugar de uma arrow anônima. Serve a duas coisas: o rastro
  // de pilha passa a dizer QUAL nível recusou, e o nível de cada rota vira algo
  // que dá para conferir de fora — é o que o smoke de permissões faz, para que
  // uma rota nova sem guard falhe no teste em vez de só em produção.
  Object.defineProperty(mw, 'name', { value: `requireAuth:${role ?? 'any'}` })
  return mw
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
