// Auth: a credencial do header Bearer é o ID token do Firebase (JWT), com a
// assinatura conferida AQUI — chave pública do Google em cache, emissor,
// público (o projeto do Data Hub), expiração e e-mail verificado. Não fala com
// a rede a cada login: é o caminho que continua funcionando quando a saída
// para o Google está bloqueada, e é o padrão que o HUBBI já usa.
//
// O caminho legado (access_token opaco do Google, validado no userinfo) foi
// REMOVIDO (SEG-07, decisão D-SEG-5 da R3 do comitê): o userinfo diz de quem é
// o token, mas não para qual aplicativo ele foi emitido. Um token que a pessoa
// entregou a QUALQUER outro app Google servia aqui, se o e-mail fosse do
// domínio. Hoje um token opaco simplesmente não é aceito.
//
// O e-mail precisa ser do domínio permitido. No primeiro login o usuário é
// criado no tenant padrão; e-mails em ADMIN_EMAILS ganham papel admin, demais
// viewer. Se o banco de metadados estiver fora, autentica só pelo domínio
// (degradado).
import type { Request, Response, NextFunction } from 'express'
import type { SessionUser } from '@datahub/shared'
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { verifyFirebaseIdToken } from './firebaseToken.js'
import { isMaster, anyMasterConfigured } from './masterAdmins.js'
import { verifyHubSession, hubOnlyActive } from './hubSso.js'

type Via = 'google' | 'hub'
const tokenCache = new Map<string, { user: SessionUser; exp: number; via: Via }>()
const TOKEN_TTL_MS = 5 * 60 * 1000

// ── Registro de entradas e recusas (M-05 do comitê) ───────────────────────
// O uso já era registrado, a entrada não: num incidente, não dava para saber
// quem entrou nem quem TENTOU. Agora: uma "auth.login" por pessoa por dia
// (a primeira requisição do dia) e cada "auth.denied" — e-mail de fora, e-mail
// não verificado, login direto com o modo "só pelo Hub", token do Hub recusado.
// Token só vencido não conta: o navegador renova sozinho, seria ruído.
const hojeLocal = () => new Date().toLocaleDateString('sv-SE') // AAAA-MM-DD no fuso do processo
const sessoesDoDia = new Set<string>()
let diaDasSessoes = ''
const recusasRecentes = new Map<string, number>()
const RECUSA_JANELA_MS = 10 * 60 * 1000 // a mesma recusa repetida vira uma linha a cada 10 min

async function gravaAuditoria(
  req: Request, action: string, email: string | null, detail: Record<string, unknown>,
): Promise<void> {
  if (!isDbAvailable()) return
  try {
    await db.query(
      `insert into audit_logs (tenant_id, user_email, action, resource_type, resource_id, detail, ip)
       select t.id, $1, $2, null, null, $3, $4 from tenants t where t.slug = 'sebratel'`,
      [email, action, JSON.stringify(detail), req.ip],
    )
  } catch (e) {
    console.warn(`[audit] falha ao registrar "${action}": ${(e as Error).message}`)
  }
}

/** Primeira requisição autenticada do dia desta pessoa: uma linha "auth.login". */
async function registraSessao(req: Request, user: SessionUser, via: Via): Promise<void> {
  const dia = hojeLocal()
  if (dia !== diaDasSessoes) { sessoesDoDia.clear(); diaDasSessoes = dia }
  const chave = user.email.toLowerCase()
  if (sessoesDoDia.has(chave) || !isDbAvailable()) return
  sessoesDoDia.add(chave)
  // Outro processo (ou o anterior a um restart) pode já ter registrado hoje.
  const ja = (await db.query(
    `select 1 from audit_logs where action = 'auth.login' and user_email = $1 and created_at >= $2`,
    [user.email, new Date(`${dia}T00:00:00`)], // meia-noite LOCAL, com o fuso junto
  ).catch(() => ({ rows: [] as unknown[] }))).rows.length
  if (!ja) await gravaAuditoria(req, 'auth.login', user.email, { via, roles: user.roles })
}

/** Tentativa recusada. A mesma (motivo + e-mail ou IP) grava no máximo uma vez a cada 10 min. */
export async function registraNegado(
  req: Request, email: string | null, motivo: string, via: Via, extra: Record<string, unknown> = {},
): Promise<void> {
  const chave = `${motivo}|${email ?? req.ip}`
  const agora = Date.now()
  const ultima = recusasRecentes.get(chave)
  if (ultima && agora - ultima < RECUSA_JANELA_MS) return
  recusasRecentes.set(chave, agora)
  if (recusasRecentes.size > 5000) {
    for (const [k, t] of recusasRecentes) if (agora - t >= RECUSA_JANELA_MS) recusasRecentes.delete(k)
  }
  await gravaAuditoria(req, 'auth.denied', email, { motivo, via, ...extra })
}

// Login direto (Google) recusado porque o Data Hub está no modo "só pelo Hub".
// É um erro à parte para a resposta dizer COMO entrar, e não "sessão inválida".
class HubOnlyError extends Error {}

export const HUB_ONLY_MESSAGE =
  'O Data Hub é acessado pelo Hub Apps. Abra o Hub e clique no Data Hub.'

// Cria/atualiza o usuário no tenant padrão e devolve seus papéis.
export async function provisionUser(p: { email: string; name: string; picture?: string }): Promise<SessionUser> {
  // Master vem do AMBIENTE (raiz de confiança) ou de uma concessão feita por
  // outro master na tela — nunca do papel 'admin', que qualquer admin concede
  // a si mesmo. Ver masterAdmins.ts.
  const master = isMaster(p.email)
  const masterConfigured = anyMasterConfigured()
  if (!isDbAvailable()) {
    return { ...p, roles: config.adminEmails.includes(p.email) ? ['admin'] : ['viewer'], tenant: 'sebratel', master, masterConfigured }
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

  return { email: p.email, name: p.name, picture: p.picture, roles, tenant: tenant.slug, master, masterConfigured }
}

// Um ID token do Firebase é um JWT: três partes separadas por ponto, a
// primeira decodificando para um cabeçalho JSON com "alg". O que não tem essa
// forma (o access_token opaco do login legado, por exemplo) é recusado aqui,
// sem gastar a verificação de assinatura.
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: unknown }
    return typeof h?.alg === 'string'
  } catch { return false }
}

async function getUserFromToken(token: string, req: Request): Promise<{ user: SessionUser; via: Via } | null> {
  const cached = tokenCache.get(token)
  if (cached && cached.exp > Date.now()) return { user: cached.user, via: cached.via }

  if (!looksLikeJwt(token)) return null

  // Sessão aberta pelo Hub Apps (HS256, chave derivada do segredo do Hub).
  const hub = verifyHubSession(token)
  if (hub) {
    const user = await provisionUser({ email: hub.email, name: hub.name })
    cacheToken(token, user, 'hub')
    return { user, via: 'hub' }
  }

  const claims = await verifyFirebaseIdToken(token)
  if (!claims) return null
  const { email, name, picture } = claims
  if (!claims.emailVerified) {
    void registraNegado(req, email, 'email_nao_verificado', 'google')
    return null
  }

  if (!email.endsWith('@' + config.allowedDomain)) {
    void registraNegado(req, email, 'dominio', 'google')
    return null
  }
  // Só pelo Hub: login direto fica para o master (caminho de recuperação).
  if (hubOnlyActive() && !isMaster(email)) {
    void registraNegado(req, email, 'hub_only', 'google')
    throw new HubOnlyError()
  }

  const user = await provisionUser({ email, name: name || email, picture })
  cacheToken(token, user, 'google')
  return { user, via: 'google' }
}

// O cache é por TOKEN, e o do Firebase dura 1h: guardar por 5 min mantém a
// propagação de mudança de papel igual à do caminho antigo.
// Sessão montada com o banco FORA (papel só de ADMIN_EMAILS) não entra: senão,
// quando o banco volta, o editor seguiria como viewer por mais 5 minutos (D-12).
function cacheToken(token: string, user: SessionUser, via: Via): void {
  if (!isDbAvailable()) return
  tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS, via })
  if (tokenCache.size > 1000) {
    const now = Date.now()
    for (const [k, v] of tokenCache) if (v.exp <= now) tokenCache.delete(k)
  }
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
    let sessao: { user: SessionUser; via: Via } | null = null
    try { sessao = await getUserFromToken(m[1], req) } catch (e) {
      if (e instanceof HubOnlyError) return res.status(403).json({ error: HUB_ONLY_MESSAGE, code: 'HUB_ONLY' })
      sessao = null
    }
    if (!sessao) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })
    const user = sessao.user
    void registraSessao(req, user, sessao.via)
    // Banco de metadados fora: o papel vem só de ADMIN_EMAILS (modo degradado),
    // e um editor de verdade levaria "sem permissão" — uma mentira. Diz o que é.
    const precisa = role === 'master' ? user.master
      : role === 'admin' ? user.roles.includes('admin')
        : role === 'editor' ? user.roles.some((r) => r === 'admin' || r === 'editor')
          : true
    if (!precisa && !isDbAvailable()) {
      return res.status(503).json({
        error: 'Banco de metadados indisponível no momento: não dá para conferir o seu papel. Tente de novo em alguns minutos.',
      })
    }
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
