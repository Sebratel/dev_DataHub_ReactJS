// ─────────────────────────────────────────────────────────────────────────
// Padronização da regra de atualização.
//
//   GET  /datasets/auto-incremental          diagnostica TODOS   (admin)
//   GET  /datasets/:id/auto-incremental      diagnostica um      (admin)
//   POST /datasets/auto-incremental/apply    aplica em lote      (admin MASTER)
//   POST /datasets/:id/reconcile-fields      casa os campos com a fonte
//                                            (admin MASTER em conjunto de fonte)
//
// O apply NUNCA inventa: ele recalcula o plano no servidor e grava o que o
// plano disser. O front manda quais conjuntos aplicar, não o que gravar —
// assim uma tela desatualizada não consegue escrever uma configuração que o
// diagnóstico atual não sustentaria.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { planAll, planFor } from './autotune.js'
import { applySyncConfig } from './syncConfig.js'
import { reconcileFields } from './reconcileFields.js'
import { requireMasterOnSource } from './masterGuard.js'

export const autotuneRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
// O DIAGNÓSTICO fica com admin de propósito: é leitura pura do catálogo e não
// muda nada. Um admin conseguir estudar o que precisa mudar — e levar isso
// pronto ao master — vale mais do que esconder a tela dele.
// Já o APPLY é master: ele só mexe em conjuntos de FONTE (planAll exclui os
// calculados), então a exigência é incondicional, sem olhar dataset a dataset.
const masterOnly = [requireAuth({ role: 'master' }), requireDb]
const masterOnSource = [...adminOnly, requireMasterOnSource]

autotuneRouter.get('/auto-incremental', ...adminOnly, async (req, res) => {
  try {
    res.json({ plans: await planAll(req.user!.tenant) })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

autotuneRouter.get('/:id/auto-incremental', ...adminOnly, async (req, res) => {
  try {
    res.json({ plan: await planFor(req.params.id) })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Aplica os planos dos conjuntos enviados. `scheduleId` é opcional: quando
// vem, os conjuntos cujo plano recomenda cadência de MINUTOS passam a seguir
// aquele agendamento; os demais recebem a cadência que o plano indicar
// (hora em hora), porque cadência de minutos em chave sem índice é justamente
// o que este diagnóstico existe para evitar.
autotuneRouter.post('/auto-incremental/apply', ...masterOnly, async (req, res) => {
  const ids = Array.isArray(req.body?.datasetIds) ? (req.body.datasetIds as unknown[]).map(String) : []
  if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um conjunto.' })
  const scheduleId = req.body?.scheduleId ? String(req.body.scheduleId) : null

  if (scheduleId) {
    const ok = (await db.query(
      `select s.id from sync_schedules s join tenants t on t.id = s.tenant_id where t.slug = $1 and s.id = $2`,
      [req.user!.tenant, scheduleId],
    )).rows[0]
    if (!ok) return res.status(404).json({ error: 'Agendamento não encontrado.' })
  }

  const results: { datasetId: string; slug: string; ok: boolean; cadence?: string; error?: string }[] = []
  for (const id of ids) {
    try {
      // Confere o tenant aqui: o plano não filtra por tenant, e um id vindo de
      // fora não pode alcançar conjunto de outro inquilino.
      const owns = (await db.query(
        `select 1 from datasets d join tenants t on t.id = d.tenant_id where d.id = $1 and t.slug = $2`,
        [id, req.user!.tenant],
      )).rows[0]
      if (!owns) { results.push({ datasetId: id, slug: id, ok: false, error: 'Conjunto não encontrado.' }); continue }

      const plan = await planFor(id)
      if (!plan.proposed) {
        results.push({ datasetId: id, slug: plan.slug, ok: false, error: plan.blocker ?? 'Sem proposta para este conjunto.' })
        continue
      }
      const minutes = plan.proposed.cadence === 'schedule' && !!scheduleId
      const r = await applySyncConfig(id, {
        syncMode: plan.proposed.mode,
        incrementalKey: plan.proposed.incrementalKey,
        incrementalKey2: plan.proposed.incrementalKey2,
        dedupeKeys: plan.proposed.dedupeKeys,
        watermarkLagMinutes: plan.proposed.watermarkLagMinutes,
        // Com agendamento escolhido, a cadência vem do assign logo abaixo —
        // mandar 'schedule' aqui seria recusado (esta rota só aceita as três
        // cadências de relógio fixo), e mandar 'hourly' antes do assign
        // deixaria o conjunto uma janela inteira na cadência errada se o
        // assign falhasse. Não mexer na cadência é o estado seguro.
        syncCadence: minutes ? null : (plan.proposed.cadence === 'schedule' ? 'hourly' : plan.proposed.cadence),
      })
      if (minutes) {
        await db.query(
          `update datasets set sync_cadence = 'schedule', schedule_id = $2, updated_at = now() where id = $1`,
          [id, scheduleId],
        )
      }
      results.push({ datasetId: id, slug: r.slug, ok: true, cadence: minutes ? 'schedule' : plan.proposed.cadence })
    } catch (e) {
      results.push({ datasetId: id, slug: id, ok: false, error: (e as Error).message })
    }
  }

  const applied = results.filter((r) => r.ok).length
  await audit(req, 'datasets.auto-incremental', { type: 'dataset', id: `${applied} conjunto(s)` },
    { requested: ids.length, applied, scheduleId })
  res.json({ applied, results })
})

// Reconcilia os campos publicados com as colunas que a fonte tem hoje: remove
// os que apontam para coluna inexistente (a causa de "column ... does not
// exist" em toda execução) e, se pedido, publica colunas novas.
//
// Exige confirmação explícita do que fazer — `removeMissing` e `addColumns`
// vêm do corpo. Reconciliar sozinho seria apagar campo de alguém sem perguntar.
autotuneRouter.post('/:id/reconcile-fields', ...masterOnSource, async (req, res) => {
  try {
    const removeMissing = req.body?.removeMissing === true
    const addColumns = Array.isArray(req.body?.addColumns)
      ? (req.body.addColumns as unknown[]).map(String) : []
    if (!removeMissing && !addColumns.length) {
      return res.status(400).json({ error: 'Nada a fazer: informe removeMissing e/ou addColumns.' })
    }
    const r = await reconcileFields(req.params.id, { removeMissing, addColumns })
    await audit(req, 'datasets.reconcile-fields', { type: 'dataset', id: req.params.id },
      { removed: r.removed.map((x) => x.sourceColumn), added: r.added.map((x) => x.sourceColumn), cleared: r.clearedConfig })
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
