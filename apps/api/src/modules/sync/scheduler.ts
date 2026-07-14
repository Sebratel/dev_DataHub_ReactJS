// Agendador diário: sincroniza todos os datasets (snapshot/incremental) na
// janela de madrugada (ETL_HOUR), um por vez — mesma lógica do etl-scheduler
// do churn_mvp. A fila sequencial do ingest garante zero concorrência.
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { enqueueSync } from './ingest.js'

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
    `select id, slug from datasets where sync_mode in ('snapshot', 'incremental')
     order by connection_id, slug`,
  )).rows
  if (!rows.length) return
  console.log(`[scheduler] ${reason}: ${rows.length} dataset(s) na fila de sync.`)
  for (const r of rows) await enqueueSync(String(r.id))
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
