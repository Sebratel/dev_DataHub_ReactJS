// Sugestões de melhoria (DB_Hub_Apps, o mesmo banco do Hub Apps). Ver store.ts.
// Ler: qualquer usuário logado. Escrever: só com PLATFORM_SUGGESTIONS_READ_ONLY=false
// (senão a tela manda para o Hub Apps). Mudar status: admin, como no Splitters.
import { Router, type Response } from 'express'
import { requireAuth, audit } from '../auth/middleware.js'
import {
  SugestaoErro, listarSugestoes, criarSugestao, votar, comentar, mudarStatus,
  faltaConfigurar, somenteLeitura, appIdSugestoes, urlHubApps, STATUS_SUGESTAO,
} from './store.js'

export const suggestionsRouter = Router()

const falha = (res: Response, e: unknown) => {
  if (e instanceof SugestaoErro) return res.status(e.status).json({ error: e.message })
  return res.status(500).json({ error: (e as Error).message })
}

const meta = () => ({
  readOnly: somenteLeitura(),
  appId: appIdSugestoes() || null,
  hubAppsUrl: urlHubApps(),
  missing: faltaConfigurar(),
  statuses: STATUS_SUGESTAO,
})

const exigeEscrita = (res: Response): boolean => {
  if (!somenteLeitura()) return true
  res.status(403).json({ error: 'Neste ambiente as sugestões são criadas, votadas e comentadas no Hub Apps.', hubAppsUrl: urlHubApps() })
  return false
}

const autor = (u: { email: string; name: string; picture?: string }) => ({ email: u.email, name: u.name, picture: u.picture ?? null })
const idDe = (v: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new SugestaoErro(400, 'Sugestão inválida.')
  return n
}

suggestionsRouter.get('/', requireAuth(), async (req, res) => {
  // Sem configuração não é erro de tela: devolve o que falta, para a página explicar.
  if (faltaConfigurar().length) return res.json({ suggestions: [], meta: meta() })
  try {
    res.json({ suggestions: await listarSugestoes(req.user!.email.toLowerCase(), Number(req.query.limit) || 200), meta: meta() })
  } catch (e) { falha(res, e) }
})

suggestionsRouter.post('/', requireAuth(), async (req, res) => {
  if (!exigeEscrita(res)) return
  try {
    const s = await criarSugestao(autor(req.user!), req.body ?? {})
    await audit(req, 'suggestions.create', { type: 'suggestion', id: String(s.id) }, { title: s.title })
    res.status(201).json({ suggestion: s })
  } catch (e) { falha(res, e) }
})

suggestionsRouter.post('/:id/vote', requireAuth(), async (req, res) => {
  if (!exigeEscrita(res)) return
  try {
    res.json({ suggestion: await votar(autor(req.user!), idDe(req.params.id), req.body?.voteType) })
  } catch (e) { falha(res, e) }
})

suggestionsRouter.post('/:id/comments', requireAuth(), async (req, res) => {
  if (!exigeEscrita(res)) return
  try {
    res.status(201).json({ suggestion: await comentar(autor(req.user!), idDe(req.params.id), req.body?.message) })
  } catch (e) { falha(res, e) }
})

suggestionsRouter.patch('/:id/status', requireAuth({ role: 'admin' }), async (req, res) => {
  if (!exigeEscrita(res)) return
  try {
    const s = await mudarStatus(req.user!.email, idDe(req.params.id), req.body?.status)
    await audit(req, 'suggestions.status', { type: 'suggestion', id: String(s.id) }, { status: s.status })
    res.json({ suggestion: s })
  } catch (e) { falha(res, e) }
})
