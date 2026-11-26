// ─────────────────────────────────────────────────────────────────────────
// Menu "Painéis": o dashia (Indicadores Sebratel) abre num quadro dentro do
// Data Hub. Com HUB_ONLY ligado lá, o dashia não aceita login próprio: quem
// está no Data Hub leva a identidade num token de lançamento.
//
// Contrato (dashia, server/hubSso.mjs → verifyDatahubLaunchToken):
//   HS256 com DASHIA_SSO_SECRET (= DATAHUB_SSO_SECRET de lá),
//   { iss: 'data-hub', aud: 'dashia', sub, email, name, via, iat, exp }, 300 s,
//   uso único lá, enviado em ?sso_token= na URL do quadro.
// `via` é a origem da sessão DESTE lado: com HUB_ONLY o dashia só aceita 'hub'.
//
// Sem segredo (ou curto demais para o dashia aceitar): 503 e a tela abre o
// dashia como antes, sem token.
// ─────────────────────────────────────────────────────────────────────────
import { createHmac, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { config } from '../../core/config.js'
import { requireAuth } from '../auth/middleware.js'

export const DASHIA_TOKEN_TTL_S = 300
// O dashia recusa segredo com menos de 32 caracteres: emitir seria inútil.
const MIN_SECRET = 32

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function dashiaSsoConfigured(): boolean {
  return config.dashia.ssoSecret.length >= MIN_SECRET
}

export function signDashiaToken(
  u: { email: string; name?: string | null },
  via: string,
  now = Math.floor(Date.now() / 1000),
): { token: string; exp: number } {
  const exp = now + DASHIA_TOKEN_TTL_S
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: 'data-hub', aud: 'dashia', sub: u.email, email: u.email, name: u.name || u.email,
    via, iat: now, exp,
    // O dashia marca o token como usado pelo hash: sem isto, dois pedidos no
    // mesmo segundo sairiam iguais e o segundo seria recusado como "já usado".
    jti: randomUUID(),
  })}`
  const sig = createHmac('sha256', config.dashia.ssoSecret).update(data).digest('base64url')
  return { token: `${data}.${sig}`, exp }
}

export const dashiaRouter = Router()

dashiaRouter.post('/sso-token', requireAuth(), (req, res) => {
  if (!dashiaSsoConfigured()) {
    return res.status(503).json({ error: 'Entrada automática nos Painéis desligada.', code: 'DASHIA_SSO_OFF' })
  }
  const { token, exp } = signDashiaToken(req.user!, req.authVia ?? 'google')
  res.set('Cache-Control', 'no-store')
  res.json({ token, expiresAt: new Date(exp * 1000).toISOString() })
})
