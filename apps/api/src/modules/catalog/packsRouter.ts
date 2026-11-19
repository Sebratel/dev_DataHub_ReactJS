// ─────────────────────────────────────────────────────────────────────────
// Pacotes de conjuntos (admin vê; master instala). Ver packs.ts.
//   GET  /api/v1/packs                 pacotes e o que de cada um já existe
//   POST /api/v1/packs/:id/install     { connectionId? } → relatório item a item
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import { isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { PACKS, packById, packStatus, installPack, PackError } from './packs.js'

export const packsRouter = Router()

packsRouter.use(requireAuth({ role: 'admin' }), (_req, res, next) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  next()
})

packsRouter.get('/', async (req, res) => {
  const packs = []
  for (const p of PACKS) packs.push(await packStatus(req.user!.tenant, p))
  res.json({ packs })
})

packsRouter.post('/:id/install', async (req, res) => {
  const pack = packById(req.params.id)
  if (!pack) return res.status(404).json({ error: 'Pacote não encontrado.' })
  try {
    const report = await installPack(req.user!, pack, { connectionId: req.body?.connectionId ?? null })
    await audit(req, 'packs.install', { type: 'pack', id: pack.id }, {
      conexao: report.connectionId,
      fontes: report.sources.map((s) => `${s.ref}:${s.status}`),
      criados: report.datasets.filter((d) => d.status === 'criado').length,
    })
    res.json({ ok: true, report })
  } catch (e) {
    if (e instanceof PackError) return res.status(e.status).json({ error: e.message })
    throw e
  }
})
