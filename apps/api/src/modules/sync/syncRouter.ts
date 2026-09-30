// Sincronização com o lake (admin): configurar modo, disparar sync e ver runs.
import { Router } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { enqueueSync, requestCancel, resumeDataset } from './ingest.js'
import { applySyncConfig, type SyncConfigInput } from './syncConfig.js'
import { requireMasterOnSource } from './masterGuard.js'

export const syncRouter = Router()

// Middlewares POR ROTA (não router.use): este router divide o prefixo
// /datasets com outros — um .use barraria rotas que não são dele.
import type { Request, Response, NextFunction } from 'express'
function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
// Mudar a REGRA de atualização de uma fonte é do admin master; num conjunto
// calculado, segue admin (ver masterGuard.ts). Disparar e cancelar uma carga
// continuam com admin: são operação, não mudança de regra — e tirá-las do
// time de operação impediria reexecutar uma carga que falhou de madrugada.
const masterOnSource = [...adminOnly, requireMasterOnSource]

// Modo de sincronização, chaves incrementais, identidade da linha, piso e
// CADÊNCIA do dataset. A regra em si mora em syncConfig.ts — compartilhada com
// a padronização em lote, para as duas não divergirem.
syncRouter.patch('/:id/sync-config', ...masterOnSource, async (req, res) => {
  try {
    const r = await applySyncConfig(req.params.id, (req.body ?? {}) as SyncConfigInput)
    await audit(req, 'datasets.sync-config', { type: 'dataset', id: r.slug }, r.applied)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Dispara um sync agora (entra na fila sequencial — nunca roda em paralelo).
syncRouter.post('/:id/sync', ...adminOnly, async (req, res) => {
  const row = (await db.query('select slug, sync_mode from datasets where id = $1', [req.params.id])).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  if (row.sync_mode === 'live') {
    return res.status(400).json({ error: 'Dataset em modo live não sincroniza — mude para snapshot ou incremental.' })
  }
  // Sincronizar À MÃO retoma um conjunto pausado por falhas seguidas: quem
  // clicou acredita que a causa mudou, e a máquina não deve discordar.
  await resumeDataset(req.params.id)
  void enqueueSync(req.params.id) // roda em background; acompanhe pelos runs
  await audit(req, 'datasets.sync', { type: 'dataset', id: row.slug })
  res.status(202).json({ queued: true })
})

// Para (cancela) a sincronização em andamento deste conjunto. Cancelamento
// cooperativo: a carga interrompe no próximo checkpoint entre lotes, descarta o
// temporário e mantém os dados antigos. Só faz efeito se houver carga rodando.
syncRouter.post('/:id/sync-cancel', ...adminOnly, async (req, res) => {
  const row = (await db.query('select slug from datasets where id = $1', [req.params.id])).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  const cancelling = requestCancel(req.params.id)
  await audit(req, 'datasets.sync-cancel', { type: 'dataset', id: row.slug }, { cancelling })
  res.json({ ok: true, cancelling })
})

syncRouter.get('/:id/sync-runs', ...adminOnly, async (req, res) => {
  const runs = (await db.query(
    `select id, mode, status, rows, bytes, error, started_at, finished_at,
            compacted, compact_ms, parts
       from sync_runs where dataset_id = $1 order by started_at desc limit 20`,
    [req.params.id],
  )).rows
  res.json({ runs })
})
