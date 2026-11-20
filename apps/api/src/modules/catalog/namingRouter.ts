// ─────────────────────────────────────────────────────────────────────────
// Padronizar nomes (admin). Ver naming.ts.
//   GET  /api/v1/datasets/naming        conjuntos, se seguem o padrão e a sugestão
//   POST /api/v1/datasets/:id/rename    { slug } → troca o nome; o antigo vira apelido
// Montado ANTES dos outros routers de /datasets: "naming" não é nome de conjunto.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import { isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { reindexEmbeddings } from '../ai/embeddings.js'
import { listaNomes, renameDataset, NamingError, NOME_MAX } from './naming.js'

export const namingRouter = Router()

const admin = requireAuth({ role: 'admin' })

namingRouter.get('/naming', admin, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  res.json({
    padrao: '<camada>_<área>_<assunto>[_<período>]',
    camadas: ['bronze', 'prata', 'ouro'],
    maximo: NOME_MAX,
    items: await listaNomes(req.user!.tenant),
  })
})

namingRouter.post('/:id/rename', admin, async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  try {
    const r = await renameDataset(req.user!, req.params.id, String(req.body?.slug ?? ''))
    await audit(req, 'datasets.rename', { type: 'dataset', id: r.to }, { de: r.from, para: r.to })
    void reindexEmbeddings(req.params.id).catch((e) =>
      console.warn(`[embeddings] reindex falhou para ${req.params.id}: ${(e as Error).message}`))
    res.json({ ok: true, slug: r.to, previous: r.from })
  } catch (e) {
    if (e instanceof NamingError) return res.status(e.status).json({ error: e.message })
    throw e
  }
})
