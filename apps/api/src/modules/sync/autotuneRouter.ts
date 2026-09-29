// ─────────────────────────────────────────────────────────────────────────
// Padronização da regra de atualização.
//
//   GET  /datasets/auto-incremental          diagnostica TODOS   (admin)
//   GET  /datasets/:id/auto-incremental      diagnostica um      (admin)
//   POST /datasets/auto-incremental/apply    aplica em lote      (admin MASTER)
//   POST /datasets/:id/reconcile-fields      casa os campos com a fonte
//                                            (admin MASTER em conjunto de fonte)
//   POST /datasets/:id/reload                relê a fonte inteira, uma vez
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
import { enqueueSync } from './ingest.js'
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

// Mensagem crua do Postgres não ajuda quem está na tela — e vaza nome de
// constraint e de coluna para o cliente. Traduz o que sabemos nomear e mantém
// o resto como veio (melhor um texto técnico do que nenhum).
function legivel(e: Error): string {
  const m = e.message
  if (m.includes('datasets_schedule_pairing_check')) {
    return 'Falha ao trocar a cadência de um conjunto que segue um agendamento nomeado. ' +
      'Isto é um defeito do servidor, não da sua seleção — avise quem mantém o Data Hub.'
  }
  if (m.includes('datasets_key2_needs_dedupe')) {
    return 'A 2ª chave incremental exige identidade da linha definida.'
  }
  if (m.includes('violates check constraint')) {
    return `O banco recusou a gravação por uma regra de consistência (${m.split('"')[1] ?? 'desconhecida'}).`
  }
  return m
}

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

  // Nome de cada conjunto ANTES de tentar gravar. Sem isto, uma falha antes do
  // planFor reportava o UUID no lugar do nome, e quem lia o erro tinha de
  // cruzar ids à mão para saber o que falhou — num lote de dezenas, inviável.
  const nomes = new Map<string, string>(
    (await db.query(
      `select d.id, d.name from datasets d join tenants t on t.id = d.tenant_id
        where d.id = any($1::uuid[]) and t.slug = $2`,
      [ids, req.user!.tenant],
    )).rows.map((r) => [String(r.id), String(r.name)]),
  )
  const nomeDe = (id: string) => nomes.get(id) ?? id

  const results: { datasetId: string; slug: string; name: string; ok: boolean; cadence?: string; error?: string; detached?: boolean }[] = []
  for (const id of ids) {
    try {
      // Confere o tenant aqui: o plano não filtra por tenant, e um id vindo de
      // fora não pode alcançar conjunto de outro inquilino.
      if (!nomes.has(id)) {
        results.push({ datasetId: id, slug: id, name: id, ok: false, error: 'Conjunto não encontrado.' })
        continue
      }

      const plan = await planFor(id)
      if (!plan.proposed) {
        results.push({
          datasetId: id, slug: plan.slug, name: plan.name, ok: false,
          error: plan.blocker ?? 'Sem proposta para este conjunto.',
        })
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
      results.push({
        datasetId: id, slug: r.slug, name: plan.name, ok: true,
        cadence: minutes ? 'schedule' : plan.proposed.cadence,
        detached: r.detachedFromSchedule && !minutes,
      })
    } catch (e) {
      results.push({ datasetId: id, slug: nomeDe(id), name: nomeDe(id), ok: false, error: legivel(e as Error) })
    }
  }

  const applied = results.filter((r) => r.ok).length
  await audit(req, 'datasets.auto-incremental', { type: 'dataset', id: `${applied} conjunto(s)` },
    { requested: ids.length, applied, scheduleId })
  // O status HTTP precisa contar a verdade. Respondendo 200 a um lote
  // integralmente recusado, qualquer cliente que confie no status — inclusive
  // a nossa própria tela — mostra sucesso e o administrador sai achando que
  // aplicou. Foi exatamente o que aconteceu com um lote de 44 conjuntos.
  //   200 = tudo aplicou · 207 = parcial · 422 = nada aplicou
  const status = applied === ids.length ? 200 : applied > 0 ? 207 : 422
  res.status(status).json({ applied, requested: ids.length, results })
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

// Recarga completa: zera o watermark e enfileira. A próxima execução relê a
// fonte inteira e SUBSTITUI o que está no lake (replaceParts).
//
// Existe porque não havia caminho seguro para isso. As alternativas pela tela
// eram armadilhas:
//   • definir um piso ("últimos N dias") zera o watermark, sim — mas a carga
//     seguinte substitui as partes antigas, então o conjunto fica só com N dias
//     e o resto do histórico É PERDIDO;
//   • trocar para snapshot e voltar para incremental relê a tabela DUAS vezes
//     (a volta zera o watermark de novo).
//
// Aqui é uma leitura só, o modo não muda, e o conjunto termina com o watermark
// correto — continuando incremental a partir dali.
autotuneRouter.post('/:id/reload', ...masterOnSource, async (req, res) => {
  const ds = (await db.query(
    `select d.slug, d.sync_mode from datasets d join tenants t on t.id = d.tenant_id
      where d.id = $1 and t.slug = $2`,
    [req.params.id, req.user!.tenant],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  if (String(ds.sync_mode) === 'live') {
    return res.status(400).json({ error: 'Conjunto em modo "ao vivo" não usa o lake — não há o que recarregar.' })
  }

  await db.query(
    `update datasets set watermark = null, watermark_2 = null, updated_at = now() where id = $1`,
    [req.params.id],
  )
  void enqueueSync(req.params.id) // fila sequencial: nunca roda em paralelo
  await audit(req, 'datasets.reload', { type: 'dataset', id: String(ds.slug) })
  res.status(202).json({ queued: true })
})
