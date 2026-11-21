// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps: o Data Hub aberto DENTRO do Hub (iframe).
//
// Como funciona:
//   1. A pessoa clica no Data Hub no Hub. O Hub confere se ela tem acesso ao
//      app e emite um token de 5 min (JWT HS256 assinado com SSO_JWT_SECRET,
//      com { sub, email, name, appId }).
//   2. O iframe abre https://data-hub…/?sso_token=<token>. A tela tira o token
//      da URL e manda para POST /api/v1/auth/hub.
//   3. Aqui o token é conferido (assinatura, validade, appId, domínio, uso
//      único) e trocado por uma SESSÃO do Data Hub, de 8 h, que vai no
//      Authorization como qualquer outro Bearer.
//
// A sessão é assinada com uma chave DERIVADA do segredo do Hub, nunca com o
// segredo em si: assim um token de lançamento do Hub não vale como sessão, e
// uma sessão não vale como token de lançamento. O papel (viewer, editor,
// admin) continua vindo do banco do Data Hub, igual ao login pelo Google.
//
// HUB_ONLY liga o "só pelo Hub": login direto pelo Google passa a ser recusado
// para quem não é master. O master continua entrando direto — é o caminho de
// recuperação se o Hub cair.
// ─────────────────────────────────────────────────────────────────────────
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../core/config.js'

const SESSION_TTL_S = 8 * 60 * 60
const SESSION_ISS = 'datahub'
const SESSION_AUD = 'datahub-hub-session'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

/** Os dois valores obrigatórios estão na stack? */
export function hubSsoConfigured(): boolean {
  return !!(config.hub.ssoSecret && config.hub.appId)
}

/**
 * "Só pelo Hub" valendo. Sem o login pelo Hub configurado, ligar HUB_ONLY
 * trancaria todo mundo (ninguém entra pelo Hub nem direto) — então só vale
 * com as duas pontas prontas.
 */
export function hubOnlyActive(): boolean {
  return config.hub.only && hubSsoConfigured()
}

function sessionKey(): Buffer {
  return createHmac('sha256', config.hub.ssoSecret).update('datahub-hub-session-v1').digest()
}

/** Confere forma, algoritmo e assinatura de um JWT HS256. Devolve o payload ou null. */
function verifyHs256(token: string, key: string | Buffer): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSig] = parts
  let header: { alg?: unknown }
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8')) as { alg?: unknown }
    payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'))
  } catch { return null }
  // Só HS256: aceitar o algoritmo que vem no cabeçalho abriria o "alg: none".
  if (header?.alg !== 'HS256') return null
  const esperado = createHmac('sha256', key).update(`${rawHeader}.${rawPayload}`).digest()
  const recebido = Buffer.from(rawSig, 'base64url')
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

// Uso único: o token viaja na URL do iframe, então pode parar em histórico ou
// log de proxy. Quem o encontrar depois não consegue reaproveitar — mesmo
// dentro dos 5 minutos. Em memória basta: a API roda num contêiner só, e
// depois de um restart o token já está perto de vencer de qualquer forma.
const usados = new Map<string, number>()

function marcarUso(token: string, expS: number): boolean {
  const ms = Date.now()
  for (const [k, exp] of usados) if (exp <= ms) usados.delete(k)
  const id = createHash('sha256').update(token).digest('hex')
  if (usados.has(id)) return false
  usados.set(id, expS * 1000)
  return true
}

export type HubLaunch =
  | { ok: true; email: string; name: string }
  | { ok: false; status: number; error: string }

const recusa = (error: string, status = 401): HubLaunch => ({ ok: false, status, error })
const ABRA_DE_NOVO = 'Abra o Data Hub de novo pelo Hub Apps.'

/** Confere o token de lançamento emitido pelo Hub Apps. */
export function verifyHubLaunchToken(token: string): HubLaunch {
  if (!hubSsoConfigured()) {
    return recusa('O acesso pelo Hub Apps não está configurado neste servidor (HUB_SSO_SECRET e HUB_APP_ID).', 503)
  }
  const p = verifyHs256(token, config.hub.ssoSecret)
  if (!p) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)

  const now = agora()
  const exp = Number(p.exp ?? 0)
  const iat = Number(p.iat ?? 0)
  if (!exp || exp <= now) return recusa(`O link de acesso venceu. ${ABRA_DE_NOVO}`)
  if (iat && iat > now + 300) return recusa(`Token do Hub inválido. ${ABRA_DE_NOVO}`)

  if (String(p.appId ?? '') !== config.hub.appId) {
    return recusa('Este token do Hub foi emitido para outro aplicativo.', 403)
  }
  const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''
  if (!email || !email.endsWith('@' + config.allowedDomain)) {
    return recusa(`Somente contas @${config.allowedDomain} acessam o Data Hub.`, 403)
  }
  if (!marcarUso(token, exp)) return recusa(`Este link de acesso já foi usado. ${ABRA_DE_NOVO}`)

  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : email
  return { ok: true, email, name }
}

/** Emite a sessão do Data Hub para quem entrou pelo Hub. */
export function issueHubSession(u: { email: string; name: string }): { token: string; expiresAt: string } {
  const iat = agora()
  const exp = iat + SESSION_TTL_S
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: SESSION_ISS, aud: SESSION_AUD, sub: u.email, email: u.email, name: u.name, iat, exp,
  })}`
  const sig = createHmac('sha256', sessionKey()).update(data).digest('base64url')
  return { token: `${data}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Sessão aberta pelo Hub, ou null se o token não é uma (ou venceu). */
export function verifyHubSession(token: string): { email: string; name: string } | null {
  if (!hubSsoConfigured()) return null
  const p = verifyHs256(token, sessionKey())
  if (!p) return null
  if (p.iss !== SESSION_ISS || p.aud !== SESSION_AUD) return null
  const exp = Number(p.exp ?? 0)
  if (!exp || exp <= agora()) return null
  const email = typeof p.email === 'string' ? p.email.toLowerCase() : ''
  if (!email.endsWith('@' + config.allowedDomain)) return null
  return { email, name: typeof p.name === 'string' && p.name ? p.name : email }
}

/** Só para teste: esquece os tokens já usados. */
export function __resetHubReplayForTest(): void {
  usados.clear()
}
