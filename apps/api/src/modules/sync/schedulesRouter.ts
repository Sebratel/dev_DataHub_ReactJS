// ─────────────────────────────────────────────────────────────────────────
// Agendamentos de sincronização (migration 028): uma política nomeada —
// janela de horário + dias da semana + intervalo em minutos — aplicada em
// LOTE a vários conjuntos de uma vez. Editar o agendamento propaga para todo
// mundo que o usa; não precisa reaplicar dataset a dataset.
//
//   GET    /schedules             lista (com quantos conjuntos usam cada um)
//   POST   /schedules             cria
//   PATCH  /schedules/:id         edita (propaga para quem usa)
//   DELETE /schedules/:id         apaga; 409 se houver conjunto usando, a
//                                 menos que ?force=true (aí eles voltam para
//                                 'daily', igual ao padrão de conexões)
//   POST   /schedules/:id/assign  aplica a N conjuntos (datasetIds[])
//   POST   /schedules/unassign    tira N conjuntos de QUALQUER agendamento,
//                                 devolvendo-os para 'daily'
//
// PERMISSÃO: criar e listar é do admin. Mas EDITAR, APAGAR, APLICAR e RETIRAR
// mudam a cadência de conjuntos já existentes — e quando algum deles é de
// FONTE, isso é mudar como a produção é consultada. Nesses casos exige admin
// MASTER (ver masterGuard.ts). Agendamento que só toca conjunto calculado
// segue com admin: calculado roda sobre o lake e não encosta em fonte.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { requireMasterOnScheduleMembers, requireMasterOnDatasetBatch } from './masterGuard.js'

export const schedulesRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
// Mudar a cadência de um conjunto de FONTE é do admin master. Estas duas
// listas dizem isso na própria definição da rota — ver masterGuard.ts.
const masterOnScheduleMembers = [...adminOnly, requireMasterOnScheduleMembers]
const masterOnBatch = [...adminOnly, requireMasterOnDatasetBatch]
const fail = (res: Response, e: unknown) => res.status(400).json({ error: (e as Error).message })

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

interface ScheduleInput {
  name: string
  intervalMinutes: number
  startTime: string
  endTime: string
  weekdays: number
}

function parseInput(body: unknown): ScheduleInput {
  const b = (body ?? {}) as Record<string, unknown>
  const name = String(b.name ?? '').trim()
  if (!name) throw new Error('Informe um nome para o agendamento.')
  const intervalMinutes = Number(b.intervalMinutes)
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error('O intervalo deve ser um número inteiro de minutos, entre 1 e 1440.')
  }
  const startTime = String(b.startTime ?? '')
  const endTime = String(b.endTime ?? '')
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    throw new Error('Informe horários no formato HH:MM.')
  }
  if (startTime >= endTime) throw new Error('O horário final deve ser depois do inicial.')
  const weekdays = Number(b.weekdays)
  if (!Number.isInteger(weekdays) || weekdays < 1 || weekdays > 127) {
    throw new Error('Selecione ao menos um dia da semana.')
  }
  return { name, intervalMinutes, startTime, endTime, weekdays }
}

schedulesRouter.get('/', ...adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select s.*,
            (select count(*) from datasets d where d.schedule_id = s.id)::int as dataset_count,
            -- Quantos são de FONTE: é o que decide se editar/apagar este
            -- agendamento exige admin master. A tela precisa saber ANTES do
            -- clique, senão o bloqueio só apareceria como 403 depois.
            (select count(*) from datasets d
              where d.schedule_id = s.id and d.kind <> 'derived')::int as source_count
       from sync_schedules s join tenants t on t.id = s.tenant_id
      where t.slug = $1 order by s.name`,
    [req.user!.tenant],
  )).rows
  res.json({
    schedules: rows.map((r) => ({
      id: String(r.id), name: String(r.name), intervalMinutes: Number(r.interval_minutes),
      startTime: String(r.start_time), endTime: String(r.end_time), weekdays: Number(r.weekdays),
      datasetCount: Number(r.dataset_count), sourceCount: Number(r.source_count),
    })),
  })
})

schedulesRouter.post('/', ...adminOnly, async (req, res) => {
  try {
    const input = parseInput(req.body)
    const row = (await db.query(
      `insert into sync_schedules (tenant_id, name, interval_minutes, start_time, end_time, weekdays, created_by)
       select t.id, $2, $3, $4, $5, $6, $7 from tenants t where t.slug = $1
       returning id`,
      [req.user!.tenant, input.name, input.intervalMinutes, input.startTime, input.endTime, input.weekdays, req.user!.email],
    )).rows[0]
    await audit(req, 'schedules.create', { type: 'schedule', id: String(row.id) }, input)
    res.status(201).json({ id: row.id })
  } catch (e) { fail(res, e) }
})

// Editar o intervalo/janela vale para TODO conjunto que usa este agendamento
// — é o efeito em lote que o torna útil, e é por isso que ele exige a mesma
// permissão da mudança individual quando há conjunto de fonte no meio.
schedulesRouter.patch('/:id', ...masterOnScheduleMembers, async (req, res) => {
  try {
    const input = parseInput(req.body)
    const row = (await db.query(
      `update sync_schedules s set
         name = $3, interval_minutes = $4, start_time = $5, end_time = $6, weekdays = $7, updated_at = now()
        from tenants t where s.tenant_id = t.id and t.slug = $1 and s.id = $2
        returning s.id`,
      [req.user!.tenant, req.params.id, input.name, input.intervalMinutes, input.startTime, input.endTime, input.weekdays],
    )).rows[0]
    if (!row) return res.status(404).json({ error: 'Agendamento não encontrado.' })
    await audit(req, 'schedules.update', { type: 'schedule', id: req.params.id }, input)
    res.json({ ok: true })
  } catch (e) { fail(res, e) }
})

// Apagar devolve todos os conjuntos para a cadência diária — mudança de
// cadência disfarçada de exclusão, e por isso com a mesma trava do editar.
schedulesRouter.delete('/:id', ...masterOnScheduleMembers, async (req, res) => {
  const sched = (await db.query(
    `select s.id from sync_schedules s join tenants t on t.id = s.tenant_id where t.slug = $1 and s.id = $2`,
    [req.user!.tenant, req.params.id],
  )).rows[0]
  if (!sched) return res.status(404).json({ error: 'Agendamento não encontrado.' })

  const inUse = Number((await db.query(
    `select count(*)::int as n from datasets where schedule_id = $1`, [req.params.id],
  )).rows[0]?.n ?? 0)
  if (inUse > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Há ${inUse} conjunto(s) usando este agendamento. Reenvie com ?force=true para excluir mesmo assim ` +
        '(eles voltam para a cadência diária).',
    })
  }
  if (inUse > 0) {
    // Volta para 'daily' ANTES de apagar o agendamento — a constraint de
    // pareamento (sync_cadence='schedule' <=> schedule_id not null) proíbe
    // deixar schedule_id nulo com cadência 'schedule' num estado intermediário.
    await db.query(
      `update datasets set sync_cadence = 'daily', schedule_id = null, updated_at = now() where schedule_id = $1`,
      [req.params.id],
    )
  }
  await db.query(`delete from sync_schedules where id = $1`, [req.params.id])
  await audit(req, 'schedules.delete', { type: 'schedule', id: req.params.id }, { datasetsReverted: inUse })
  res.json({ ok: true, datasetsReverted: inUse })
})

// Aplica este agendamento aos IDs enviados — de uma vez, em lote. IDs que não
// existirem (ou de outro tenant) são ignorados silenciosamente: o front manda
// só o que o usuário selecionou na tela, então isto é rede de segurança, não
// caminho esperado.
schedulesRouter.post('/:id/assign', ...masterOnBatch, async (req, res) => {
  const ids = Array.isArray(req.body?.datasetIds) ? (req.body.datasetIds as unknown[]).map(String) : []
  if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um conjunto.' })
  const sched = (await db.query(
    `select s.id from sync_schedules s join tenants t on t.id = s.tenant_id where t.slug = $1 and s.id = $2`,
    [req.user!.tenant, req.params.id],
  )).rows[0]
  if (!sched) return res.status(404).json({ error: 'Agendamento não encontrado.' })

  const r = await db.query(
    `update datasets d set sync_cadence = 'schedule', schedule_id = $2, updated_at = now()
       from tenants t where d.tenant_id = t.id and t.slug = $1 and d.id = any($3::uuid[])`,
    [req.user!.tenant, req.params.id, ids],
  )
  await audit(req, 'schedules.assign', { type: 'schedule', id: req.params.id }, { datasetIds: ids, count: r.rowCount })
  res.json({ ok: true, applied: r.rowCount })
})

schedulesRouter.post('/unassign', ...masterOnBatch, async (req, res) => {
  const ids = Array.isArray(req.body?.datasetIds) ? (req.body.datasetIds as unknown[]).map(String) : []
  if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um conjunto.' })
  const r = await db.query(
    `update datasets d set sync_cadence = 'daily', schedule_id = null, updated_at = now()
       from tenants t where d.tenant_id = t.id and t.slug = $1 and d.id = any($2::uuid[]) and d.sync_cadence = 'schedule'`,
    [req.user!.tenant, ids],
  )
  await audit(req, 'schedules.unassign', { type: 'dataset', id: ids.join(',') }, { count: r.rowCount })
  res.json({ ok: true, removed: r.rowCount })
})
