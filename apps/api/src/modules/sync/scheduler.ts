// Agendador: verifica a cada MINUTO quais conjuntos estão "vencidos".
//   'hourly'   toda hora cheia
//   'daily'    só na janela ETL_HOUR
//   'manual'   nunca (só sob demanda pelo admin)
//   'cascade'  nunca pelo relógio — dispara direto no fim de um sync bem
//              sucedido de quem ele referencia (ver cascadeToDependents em
//              ingest.ts), não tem tick aqui
//   'schedule' segue a janela de horário/dia + intervalo em minutos de um
//              sync_schedules — é o único que precisa do tick por MINUTO;
//              os demais continuam bastando checar na hora cheia
// Fontes primeiro; derivados em ordem topológica (cadeias). A fila sequencial
// do ingest garante zero concorrência entre tudo isto.
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { enqueueSync } from './ingest.js'
import { orderDerived } from '../transform/derive.js'
import { reindexEmbeddings } from '../ai/embeddings.js'
import { runDueHealthChecks } from '../../connectors/healthChecks.js'
import { isWithinSchedule } from '@datahub/shared'

function msUntilNextMinute(): number {
  const now = new Date()
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setMinutes(now.getMinutes() + 1)
  return next.getTime() - now.getTime()
}

// A lógica de sempre (hourly/daily) — só precisa rodar quando o minuto vira 0.
async function tickHourlyAndDaily(hour: number): Promise<void> {
  const rows = (await db.query(
    `select id, slug, kind, transform_sql, sync_cadence from datasets
      where sync_mode in ('snapshot', 'incremental') and sync_cadence in ('hourly', 'daily')`,
  )).rows

  const due = rows.filter((r) =>
    r.sync_cadence === 'hourly' || (r.sync_cadence === 'daily' && hour === config.sync.hour))
  if (!due.length) return

  // Fontes primeiro; depois derivados em ordem de dependência.
  const sources = due.filter((r) => r.kind !== 'derived')
  const deriveds = orderDerived(
    due.filter((r) => r.kind === 'derived')
      .map((r) => ({ id: String(r.id), slug: String(r.slug), transformSql: r.transform_sql as string | null })),
  )
  const queue = [...sources.map((r) => String(r.id)), ...deriveds.map((d) => d.id)]
  console.log(`[scheduler] ${hour}h: ${queue.length} conjunto(s) vencido(s) (${sources.length} fonte(s), ${deriveds.length} derivado(s)).`)
  for (const id of queue) await enqueueSync(id)
}

// Cadência 'schedule': dentro da janela (dia + horário) E já passou o
// intervalo desde o último sync bem-sucedido. Roda TODO minuto — é o motivo
// de o tick geral ter deixado de ser por hora.
async function tickSchedules(now: Date): Promise<void> {
  const rows = (await db.query(
    `select d.id, d.slug, d.last_sync_at,
            s.interval_minutes, s.start_time, s.end_time, s.weekdays
       from datasets d join sync_schedules s on s.id = d.schedule_id
      where d.sync_cadence = 'schedule' and d.sync_mode in ('snapshot', 'incremental')`,
  )).rows

  for (const r of rows) {
    const sched = { startTime: String(r.start_time), endTime: String(r.end_time), weekdays: Number(r.weekdays) }
    if (!isWithinSchedule(sched, now)) continue
    const last = r.last_sync_at ? new Date(r.last_sync_at as string).getTime() : 0
    const dueMs = Number(r.interval_minutes) * 60_000
    if (now.getTime() - last < dueMs) continue
    console.log(`[scheduler] agendamento: "${String(r.slug)}" vencido (>= ${r.interval_minutes} min dentro da janela).`)
    void enqueueSync(String(r.id)) // não bloqueia o tick deste minuto pelos demais
  }
}

async function tick(): Promise<void> {
  if (!isDbAvailable()) return
  const now = new Date()
  if (now.getMinutes() === 0) {
    // Mantém o catálogo semântico fresco: pega derivados cujos campos só
    // existem após a materialização, e qualquer edição que tenha escapado.
    void reindexEmbeddings().catch((e) =>
      console.warn(`[embeddings] reindex periódico falhou: ${(e as Error).message}`))
    await tickHourlyAndDaily(now.getHours())
  }
  await tickSchedules(now)
}

export function startScheduler(): void {
  const schedule = () => {
    const ms = msUntilNextMinute()
    setTimeout(async () => {
      try { await tick() } catch (e) { console.error(`[scheduler] falha no tick: ${(e as Error).message}`) }
      schedule()
    }, ms)
  }
  console.log(
    `[scheduler] verificação a cada minuto (agendamentos 'schedule') e a cada hora cheia ` +
    `(janela diária ETL_HOUR=${config.sync.hour}h; demais cadências). Próxima em ${Math.round(msUntilNextMinute() / 1000)}s.`,
  )
  schedule()
}

// Health checks (Fase 3): a cada 60s executa os que estão vencidos pela sua
// cadência (interval_minutes). Independente da fila de sync.
export function startHealthChecks(): void {
  setInterval(() => {
    void runDueHealthChecks().catch((e) => console.error(`[healthcheck] falha: ${(e as Error).message}`))
  }, 60_000)
  console.log('[healthcheck] monitor ativo (verifica a cada 60s).')
}
