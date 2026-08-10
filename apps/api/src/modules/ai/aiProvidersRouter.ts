// Administração dos provedores de IA. Só admin: a chave dá acesso faturado ao
// provedor, e trocar o padrão muda o modelo que responde para o tenant inteiro.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { hasSecret } from '../../core/crypto.js'
import {
  listCached, createProvider, updateProvider, deleteProvider, setDefault, testProvider,
  listProviderModels, type ProviderInput,
} from './providerStore.js'
import type { ProviderKind } from './provider.js'

export const aiProvidersRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
const fail = (res: Response, e: unknown) => res.status(400).json({ error: (e as Error).message })

aiProvidersRouter.get('/', ...adminOnly, (req, res) => {
  res.json({
    providers: listCached(req.user!.tenant),
    // Sem CONNECTIONS_SECRET não há como cifrar a chave — a tela avisa antes
    // de a pessoa preencher o formulário e receber um erro ao salvar.
    secretConfigured: hasSecret(),
  })
})

// Modelos disponíveis para a chave. POST porque a chave pode vir no corpo
// (provedor ainda não salvo) — chave em query string acabaria em log de acesso.
aiProvidersRouter.post('/models', ...adminOnly, async (req, res) => {
  const b = (req.body ?? {}) as { id?: string; kind?: ProviderKind; apiKey?: string; baseUrl?: string | null }
  try {
    res.json({ models: await listProviderModels(req.user!.tenant, b) })
  } catch (e) { fail(res, e) }
})

aiProvidersRouter.post('/', ...adminOnly, async (req, res) => {
  try {
    const p = await createProvider(req.user!.tenant, req.body as ProviderInput, req.user!.email)
    await audit(req, 'ai.provider.create', { type: 'ai_provider', id: p.id },
      { kind: p.kind, model: p.model })
    res.status(201).json({ provider: p })
  } catch (e) { fail(res, e) }
})

aiProvidersRouter.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const p = await updateProvider(req.user!.tenant, req.params.id, req.body as ProviderInput)
    await audit(req, 'ai.provider.update', { type: 'ai_provider', id: p.id },
      { kind: p.kind, model: p.model })
    res.json({ provider: p })
  } catch (e) { fail(res, e) }
})

aiProvidersRouter.post('/:id/default', ...adminOnly, async (req, res) => {
  try {
    await setDefault(req.user!.tenant, req.params.id)
    await audit(req, 'ai.provider.default', { type: 'ai_provider', id: req.params.id })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

// Teste de conexão: uma pergunta trivial ao provedor. Devolve 200 mesmo quando
// falha — o resultado do teste É a resposta, não um erro da nossa API.
aiProvidersRouter.post('/:id/test', ...adminOnly, async (req, res) => {
  try {
    res.json(await testProvider(req.user!.tenant, req.params.id))
  } catch (e) { fail(res, e) }
})

aiProvidersRouter.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    await deleteProvider(req.user!.tenant, req.params.id)
    await audit(req, 'ai.provider.delete', { type: 'ai_provider', id: req.params.id })
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})
