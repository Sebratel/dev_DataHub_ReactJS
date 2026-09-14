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

// Modo de sincronização, chaves incrementais, identidade da linha, piso e
// CADÊNCIA do dataset.
syncRouter.patch('/:id/sync-config', ...adminOnly, async (req, res) => {
  const {
    syncMode, incrementalKey, incrementalKey2, syncCadence, syncSince,
    syncSinceDays, dedupeKeys, watermarkLagMinutes,
  } = req.body ?? {}
  if (!['live', 'snapshot', 'incremental'].includes(syncMode)) {
    return res.status(400).json({ error: 'syncMode deve ser live, snapshot ou incremental.' })
  }
  if (syncCadence != null && !['daily', 'hourly', 'manual'].includes(syncCadence)) {
    return res.status(400).json({ error: 'syncCadence deve ser daily, hourly ou manual.' })
  }

  const incremental = syncMode === 'incremental'
  const known = new Set((await db.query(
    `select key from dataset_fields where dataset_id = $1`, [req.params.id],
  )).rows.map((r) => String(r.key)))

  // Fora do incremental, tudo que é incremental zera — não fica configuração
  // órfã descrevendo um comportamento que o modo atual não executa.
  const key1 = incremental ? String(incrementalKey ?? '') : ''
  const key2 = incremental && incrementalKey2 ? String(incrementalKey2) : ''
  const dedupe: string[] = incremental && Array.isArray(dedupeKeys)
    ? [...new Set((dedupeKeys as unknown[]).map(String).filter(Boolean))] : []

  if (incremental && !known.has(key1)) {
    return res.status(400).json({ error: 'incrementalKey precisa ser um campo do dataset.' })
  }
  if (key2 && !known.has(key2)) {
    return res.status(400).json({ error: 'A 2ª chave incremental precisa ser um campo do dataset.' })
  }
  if (key2 && key2 === key1) {
    return res.status(400).json({ error: 'A 2ª chave precisa ser diferente da primeira.' })
  }
  const unknownDedupe = dedupe.filter((k) => !known.has(k))
  if (unknownDedupe.length) {
    return res.status(400).json({ error: `Identidade da linha inválida: ${unknownDedupe.join(', ')}.` })
  }
  // Mesma regra da constraint do banco, dita em português: sem identidade, duas
  // passadas trazem a mesma linha duas vezes e nada as junta depois.
  if (key2 && !dedupe.length) {
    return res.status(400).json({
      error: 'Para usar duas chaves é preciso definir a identidade da linha (ex.: id) — ' +
        'sem ela, a linha que foi criada E editada entraria duplicada no lake.',
    })
  }

  // "Ponto de partida": data FIXA ou RELATIVA (últimos N dias), nunca as duas.
  const since = incremental && syncSince != null && String(syncSince).trim() !== ''
    ? String(syncSince).trim() : null
  const sinceDays = incremental && syncSinceDays != null && String(syncSinceDays).trim() !== ''
    ? Number(syncSinceDays) : null
  if (sinceDays != null && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 3650)) {
    return res.status(400).json({ error: 'O piso relativo deve ser um número inteiro de dias, entre 1 e 3650.' })
  }
  if (since != null && sinceDays != null) {
    return res.status(400).json({ error: 'Escolha um piso só: data fixa OU últimos N dias.' })
  }
  const lag = incremental && watermarkLagMinutes != null ? Number(watermarkLagMinutes) : 0
  if (!Number.isInteger(lag) || lag < 0 || lag > 10080) {
    return res.status(400).json({ error: 'A folga de reconferência deve ser de 0 a 10080 minutos (7 dias).' })
  }

  const current = (await db.query(
    `select sync_mode, sync_since, sync_since_days, incremental_key, incremental_key_2
       from datasets where id = $1`, [req.params.id],
  )).rows[0]
  if (!current) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  // Zera o watermark (força recarga do zero) quando o MODO muda OU quando o piso
  // muda — em ambos os casos, o que o dataset contém foi redefinido. Mudar só a
  // cadência preserva o progresso incremental.
  const modeChanged = current.sync_mode !== syncMode
  const sinceChanged = (current.sync_since ?? null) !== since
    || (current.sync_since_days ?? null) !== sinceDays
  const resetAll = modeChanged || sinceChanged
  // Trocar a CHAVE também invalida o watermark dela: o valor guardado é o maior
  // da coluna ANTIGA e, aplicado à nova, pularia tudo que estiver atrás dele.
  const reset1 = resetAll || (current.incremental_key ?? null) !== (key1 || null)
  const reset2 = resetAll || (current.incremental_key_2 ?? null) !== (key2 || null)

  const row = (await db.query(
    `update datasets set
       sync_mode = $2, incremental_key = $3, incremental_key_2 = $4,
       sync_cadence = coalesce($5, sync_cadence),
       sync_since = $6, sync_since_days = $7,
       dedupe_keys = $8, watermark_lag_minutes = $9,
       watermark   = case when $10 then null else watermark end,
       watermark_2 = case when $11 then null else watermark_2 end,
       updated_at = now()
     where id = $1 returning slug`,
    [req.params.id, syncMode, key1 || null, key2 || null,
     syncCadence ?? null, since, sinceDays, dedupe, lag, reset1, reset2],
  )).rows[0]
  await audit(req, 'datasets.sync-config', { type: 'dataset', id: row.slug },
    { syncMode, incrementalKey: key1, incrementalKey2: key2, syncCadence, since, sinceDays, dedupe, lag })
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
