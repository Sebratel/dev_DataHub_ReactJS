// Rotas PÚBLICAS de entrada (antes do login): a tela pergunta como entrar e
// troca o token do Hub Apps por uma sessão. Ver hubSso.ts.
import { Router } from 'express'
import { config } from '../../core/config.js'
import { audit, provisionUser, registraNegado } from './middleware.js'
import { hubOnlyActive, hubSsoConfigured, issueHubSession, verifyHubLaunchToken } from './hubSso.js'

export const authHubRouter = Router()

// Como a tela de login deve se apresentar. Não revela nada além do que a
// própria tela mostra: se o acesso é só pelo Hub e para onde mandar a pessoa.
authHubRouter.get('/config', (_req, res) => {
  res.json({ hubOnly: hubOnlyActive(), hubLogin: hubSsoConfigured(), hubUrl: config.hub.url })
})

// Troca o token de 5 min do Hub por uma sessão de 8 h do Data Hub.
authHubRouter.post('/hub', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) return res.status(400).json({ error: 'Token do Hub ausente.' })

  const r = verifyHubLaunchToken(token)
  if (!r.ok) {
    // M-05: tentativa recusada fica registrada (sem e-mail: o token não foi aceito).
    if (r.status !== 503) void registraNegado(req, null, 'token_do_hub', 'hub', { erro: r.error })
    return res.status(r.status).json({ error: r.error })
  }

  const user = await provisionUser({ email: r.email, name: r.name })
  const session = issueHubSession({ email: r.email, name: r.name })
  req.user = user
  void audit(req, 'auth.login_hub')
  res.json({ ...session, user })
})
