// Agendador diário: sincroniza todos os datasets (snapshot/incremental) na
// janela de madrugada (ETL_HOUR), um por vez — mesma lógica do etl-scheduler
// do churn_mvp. A fila sequencial do ingest garante zero concorrência.
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { enqueueSync } from './ingest.js'
import { orderDerived } from '../transform/derive.js'

function msUntilHour(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

async function syncAll(reason: string): Promise<void> {
  if (!isDbAvailable()) return
  const rows = (await db.query(
    `select id, slug, kind, transform_sql from datasets
      where sync_mode in ('snapshot', 'incremental')
      order by connection_id, slug`,
  )).rows
  if (!rows.length) return

  // FONTES primeiro; depois DERIVADOS em ordem topológica (um derivado que
  // referencia outro materializa DEPOIS dele — cadeias fonte→derivado→derivado).
  const sources = rows.filter((r) => r.kind !== 'derived')
  const deriveds = orderDerived(
    rows.filter((r) => r.kind === 'derived')
      .map((r) => ({ id: String(r.id), slug: String(r.slug), transformSql: r.transform_sql as string | null })),
  )
  const queue = [...sources.map((r) => String(r.id)), ...deriveds.map((d) => d.id)]
  console.log(`[scheduler] ${reason}: ${queue.length} dataset(s) na fila (${sources.length} fonte(s), ${deriveds.length} derivado(s)).`)
  for (const id of queue) await enqueueSync(id)
}

export function startScheduler(): void {
  const schedule = () => {
    const ms = msUntilHour(config.sync.hour)
    console.log(`[scheduler] próximo sync completo em ${(ms / 3_600_000).toFixed(1)} h (ETL_HOUR=${config.sync.hour}).`)
    setTimeout(async () => {
      await syncAll('janela diária')
      schedule()
    }, ms)
  }
  schedule()
}
