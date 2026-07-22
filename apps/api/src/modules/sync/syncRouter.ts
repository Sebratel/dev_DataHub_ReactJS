// Sincronização com o lake (admin): configurar modo, disparar sync e ver runs.
import { Router } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { enqueueSync, requestCancel } from './ingest.js'

export const syncRouter = Router()

// Middlewares POR ROTA (não router.use): este router divide o prefixo
// /datasets com outros — um .use barraria rotas que não são dele.
import type { Request, Response, NextFunction } from 'express'
function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]

// Modo de sincronização, chave incremental e CADÊNCIA do dataset.
syncRouter.patch('/:id/sync-config', ...adminOnly, async (req, res) => {
  const { syncMode, incrementalKey, syncCadence, syncSince } = req.body ?? {}
  if (!['live', 'snapshot', 'incremental'].includes(syncMode)) {
    return res.status(400).json({ error: 'syncMode deve ser live, snapshot ou incremental.' })
  }
  if (syncCadence != null && !['daily', 'hourly', 'manual'].includes(syncCadence)) {
    return res.status(400).json({ error: 'syncCadence deve ser daily, hourly ou manual.' })
  }
  if (syncMode === 'incremental') {
    const field = (await db.query(
      `select 1 from dataset_fields where dataset_id = $1 and key = $2`,
      [req.params.id, incrementalKey ?? ''],
    )).rows[0]
    if (!field) return res.status(400).json({ error: 'incrementalKey precisa ser um campo do dataset.' })
  }
  // "Ponto de partida": só faz sentido no incremental; nos demais modos, zera.
  const since = syncMode === 'incremental' && syncSince != null && String(syncSince).trim() !== ''
    ? String(syncSince).trim() : null
  const current = (await db.query('select sync_mode, sync_since from datasets where id = $1', [req.params.id])).rows[0]
  if (!current) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  // Zera o watermark (força recarga do zero) quando o MODO muda OU quando o piso
  // muda — em ambos os casos, o que o dataset contém foi redefinido. Mudar só a
  // cadência preserva o progresso incremental.
  const modeChanged = current.sync_mode !== syncMode
  const sinceChanged = (current.sync_since ?? null) !== since
  const resetWatermark = modeChanged || sinceChanged
  const row = (await db.query(
    `update datasets set
       sync_mode = $2, incremental_key = $3,
       sync_cadence = coalesce($4, sync_cadence),
       sync_since = $5,
       watermark = case when $6 then null else watermark end,
       updated_at = now()
     where id = $1 returning slug`,
    [req.params.id, syncMode, syncMode === 'incremental' ? incrementalKey : null,
     syncCadence ?? null, since, resetWatermark],
  )).rows[0]
  await audit(req, 'datasets.sync-config', { type: 'dataset', id: row.slug }, { syncMode, incrementalKey, syncCadence, since })
  res.json({ ok: true })
})

// Dispara um sync agora (entra na fila sequencial — nunca roda em paralelo).
syncRouter.post('/:id/sync', ...adminOnly, async (req, res) => {
  const row = (await db.query('select slug, sync_mode from datasets where id = $1', [req.params.id])).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  if (row.sync_mode === 'live') {
    return res.status(400).json({ error: 'Dataset em modo live não sincroniza — mude para snapshot ou incremental.' })
  }
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
    `select id, mode, status, rows, bytes, error, started_at, finished_at
       from sync_runs where dataset_id = $1 order by started_at desc limit 20`,
    [req.params.id],
  )).rows
  res.json({ runs })
})
