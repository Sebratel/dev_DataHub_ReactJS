// Agendador: verifica DE HORA EM HORA quais conjuntos estão "vencidos" pela
// cadência de cada um — 'hourly' toda hora, 'daily' só na janela ETL_HOUR,
// 'manual' nunca. Fontes primeiro; derivados em ordem topológica (cadeias).
// A fila sequencial do ingest garante zero concorrência.
import { config } from '../../core/config.js'
import { db, isDbAvailable } from '../../db/pool.js'
import { enqueueSync } from './ingest.js'
import { orderDerived } from '../transform/derive.js'
import { reindexEmbeddings } from '../ai/embeddings.js'
import { runDueHealthChecks } from '../../connectors/healthChecks.js'

function msUntilNextHour(): number {
  const now = new Date()
  const next = new Date(now)
  next.setHours(now.getHours() + 1, 0, 0, 0)
  return next.getTime() - now.getTime()
}

async function tick(): Promise<void> {
  if (!isDbAvailable()) return
  // Mantém o catálogo semântico fresco: pega derivados cujos campos só existem
  // após a materialização, e qualquer edição que tenha escapado. Só recomputa
  // o que mudou; é barato e roda em background.
  void reindexEmbeddings().catch((e) =>
    console.warn(`[embeddings] reindex periódico falhou: ${(e as Error).message}`))
  const hour = new Date().getHours()
  const rows = (await db.query(
    `select id, slug, kind, transform_sql, sync_cadence from datasets
      where sync_mode in ('snapshot', 'incremental')`,
  )).rows

  // Vencidos nesta hora: hourly sempre; daily só na hora do ETL; manual nunca.
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

export function startScheduler(): void {
  const schedule = () => {
    const ms = msUntilNextHour()
    setTimeout(async () => {
      try { await tick() } catch (e) { console.error(`[scheduler] falha no tick: ${(e as Error).message}`) }
      schedule()
    }, ms)
  }
  console.log(`[scheduler] verificação a cada hora cheia (janela diária ETL_HOUR=${config.sync.hour}h; cadência por conjunto). Próxima em ${Math.round(msUntilNextHour() / 60000)} min.`)
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
