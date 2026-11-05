// ─────────────────────────────────────────────────────────────────────────
// Conciliação fonte × lake — a execução (D-QLD-3, R4 de 30/10/2026).
//
// Ciclo de uma conferência:
//   1. o pedido (diário ou "Conciliar agora") grava uma linha 'queued' e põe
//      o conjunto na fila de cargas;
//   2. a carga roda como qualquer outra; no fim, AINDA DENTRO da fila
//      (setAfterSync), a conferência lê a fonte e o lake;
//   3. o resultado fica em reconcile_runs, e divergência ou falha vira alerta.
//
// Por que carregar antes de conferir: o lake de um conjunto diário pode ter
// 20 horas. Comparar com a fonte de agora acusaria como "perda" tudo o que foi
// criado desde então. Logo depois da carga, a única diferença legítima é a
// que o watermark já delimita — e o que sobrar é defeito de verdade.
//
// E por que dentro da fila: a regra de uma consulta por vez na produção
// (ingest.ts) vale também para a conferência. Ela nunca roda em paralelo com
// uma carga, nem com outra conferência.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { getConnector } from '../../connectors/registry.js'
import { querySource } from '../../connectors/pools.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'
import { enqueueSync, setAfterSync, normalizaWatermark, type SyncOutcome } from '../sync/ingest.js'
import { notify } from '../alerts/notify.js'
import {
  planReconcile, ineligibleReason, bandOf, quoteFor, sourceCountSql, sourceLostSql, lakeCountSql,
  toBucket, compareBuckets, isMatch, sameSum, timestampLocal,
  type Dialect, type PlanDataset, type PlanRules,
} from './reconcilePlan.js'
import type { ReconcileBand } from '@datahub/shared'

export function rules(): PlanRules {
  return {
    smallMaxRows: config.quality.smallMaxRows,
    largeMinRows: config.quality.largeMinRows,
    largeWindowDays: config.quality.largeWindowDays,
  }
}

/** O conjunto como a regra de conciliação o vê (catálogo + conexão). */
async function loadDataset(datasetId: string): Promise<{ row: Record<string, any>; plan: PlanDataset } | null> {
  const row = (await db.query(
    `select d.*, t.slug as tenant_slug from datasets d join tenants t on t.id = d.tenant_id where d.id = $1`,
    [datasetId],
  )).rows[0]
  if (!row) return null
  const fields = (await db.query(
    `select key, source_column, type from dataset_fields where dataset_id = $1 order by sort_order`,
    [datasetId],
  )).rows.map((f) => ({ key: String(f.key), sourceColumn: String(f.source_column), type: String(f.type) }))
  const def = row.kind === 'derived' ? undefined : getConnector(String(row.connection_id))
  return {
    row,
    plan: {
      kind: String(row.kind),
      connectorKind: def ? def.kind : null,
      syncMode: String(row.sync_mode),
      incrementalKey: row.incremental_key ?? null,
      incrementalKey2: row.incremental_key_2 ?? null,
      dedupeKeys: ((row.dedupe_keys as string[] | null) ?? []).filter(Boolean),
      watermark: normalizaWatermark(row.watermark ?? null),
      watermarkLagMinutes: Number(row.watermark_lag_minutes ?? 0),
      syncSince: row.sync_since ?? null,
      syncSinceDays: row.sync_since_days == null ? null : Number(row.sync_since_days),
      lastFullReloadAt: row.last_full_reload_at ? new Date(row.last_full_reload_at) : null,
      rowCount: row.row_count == null ? null : Number(row.row_count),
      fields,
    },
  }
}

// ── Pedido ───────────────────────────────────────────────────────────────
/**
 * Pede uma conciliação: grava 'queued' e põe o conjunto na fila de cargas. A
 * conferência acontece no fim dessa carga. Pedido repetido enquanto o
 * anterior espera devolve o anterior (índice único no banco).
 */
export async function requestReconcile(
  datasetId: string, trigger: 'daily' | 'manual', requestedBy: string,
): Promise<{ id: string; already: boolean }> {
  const ds = await loadDataset(datasetId)
  if (!ds) throw new Error('Conjunto de dados não encontrado.')
  const motivo = ineligibleReason(ds.plan)
  if (motivo) throw new Error(motivo)

  const pendente = (await db.query(
    `select id from reconcile_runs where dataset_id = $1 and status in ('queued', 'running')`, [datasetId],
  )).rows[0]
  if (pendente) return { id: String(pendente.id), already: true }

  const band: ReconcileBand = bandOf(ds.plan.rowCount, rules())
  let id: string
  try {
    id = String((await db.query(
      `insert into reconcile_runs (dataset_id, trigger, band, requested_by) values ($1, $2, $3, $4) returning id`,
      [datasetId, trigger, band, requestedBy],
    )).rows[0].id)
  } catch (e) {
    // Dois pedidos no mesmo instante: o índice único deixou passar um só.
    if ((e as { code?: string }).code === '23505') {
      const r = (await db.query(
        `select id from reconcile_runs where dataset_id = $1 and status in ('queued', 'running')`, [datasetId],
      )).rows[0]
      if (r) return { id: String(r.id), already: true }
    }
    throw e
  }
  void enqueueSync(datasetId)
  return { id, already: false }
}

// ── Depois da carga ──────────────────────────────────────────────────────
async function afterSync(datasetId: string, outcome: SyncOutcome): Promise<void> {
  const pendentes = (await db.query(
    `select id from reconcile_runs where dataset_id = $1 and status = 'queued' order by created_at`, [datasetId],
  )).rows
  for (const p of pendentes) {
    if (outcome.ok) await runReconcile(String(p.id))
    else {
      await finishWithError(String(p.id), datasetId,
        `A carga que vem antes da conferência não terminou (${outcome.result.slice(0, 300)}). ` +
        'Nada foi comparado: sem a carga, a fonte e o lake estariam em momentos diferentes.')
    }
  }
}
setAfterSync(afterSync)

async function finishWithError(runId: string, datasetId: string, error: string): Promise<void> {
  await db.query(
    `update reconcile_runs set status = 'error', error = $2, finished_at = now(),
                              started_at = coalesce(started_at, now())
      where id = $1`,
    [runId, error],
  )
  const ds = (await db.query(`select tenant_id, slug, name from datasets where id = $1`, [datasetId])).rows[0]
  if (!ds) return
  await notify(String(ds.tenant_id), {
    key: `reconcile:error:${datasetId}`,
    kind: 'reconcile-error',
    title: `Conciliação não concluída: ${ds.name}`,
    lines: [`Conjunto ${ds.slug}.`, error.slice(0, 500), 'Veja em Operar › Qualidade dos dados.'],
  })
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'))
const fmtDia = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d)

/** A conferência em si. Roda dentro da fila (ver afterSync). */
export async function runReconcile(runId: string): Promise<void> {
  const run = (await db.query(`select dataset_id from reconcile_runs where id = $1`, [runId])).rows[0]
  if (!run) return
  const datasetId = String(run.dataset_id)
  await db.query(`update reconcile_runs set status = 'running', started_at = now() where id = $1`, [runId])

  try {
    const ds = await loadDataset(datasetId)
    if (!ds) throw new Error('Conjunto de dados não encontrado.')
    const plan = planReconcile(ds.plan, rules())
    if (!plan.ok) throw new Error(plan.reason)

    const dialect = ds.plan.connectorKind as Dialect
    const q = quoteFor(dialect)
    const from = `${q(String(ds.row.schema_name))}.${q(String(ds.row.object_name))}`
    const dir = datasetDir(String(ds.row.tenant_slug), String(ds.row.slug))
    const temLake = listParquet(dir).length > 0
    const glob = parquetGlob(dir)

    // Piso relativo de uma carga anterior à marca de recarga: o limite de
    // baixo é o que o lake efetivamente tem.
    let lower = plan.lower
    if (plan.lowerFromLake && plan.keyField && temLake) {
      const k = `"${plan.keyField.key.replace(/"/g, '""')}"`
      const m = (await duckQuery(`select min(${k}) as m from read_parquet('${glob}')`)).rows[0]?.m
      if (m != null) lower = String(m).replace('T', ' ')
    }
    const bounds = { method: plan.method, keyField: plan.keyField, sumField: plan.sumField, lower, upper: plan.upper }

    // ── Fonte ────────────────────────────────────────────────────────────
    const t0 = Date.now()
    const conn = String(ds.row.connection_id)
    const sc = sourceCountSql(dialect, from, bounds)
    const fonte = (await querySource(conn, sc.sql, sc.params)).rows.map(toBucket)
    const lostRows = plan.lostCheck
      ? Number((await querySource(conn, sourceLostSql(dialect, from, plan.lostCheck))).rows[0]?.n ?? 0)
      : 0
    const sourceMs = Date.now() - t0

    // ── Lake ─────────────────────────────────────────────────────────────
    const lake = temLake ? (await duckQuery(lakeCountSql(glob, bounds))).rows.map(toBucket) : []
    const notes = [...plan.notes]
    if (plan.keyField?.isDate && temLake) {
      const k = `"${plan.keyField.key.replace(/"/g, '""')}"`
      const semData = Number((await duckQuery(
        `select count(*) as n from read_parquet('${glob}') where ${k} is null`)).rows[0]?.n ?? 0)
      if (semData) {
        notes.push(`${fmt(semData)} linha(s) do lake sem ${plan.keyField.key} válida ficam fora da comparação ` +
          '(data vazia ou inválida na fonte, como 0000-00-00).')
      }
    }

    const c = compareBuckets(fonte, lake, !!plan.sumField)
    const ok = isMatch(c, lostRows)
    const porDia = plan.method === 'per-day'
    const diffDays = porDia ? c.diverged : []

    await db.query(
      `update reconcile_runs set status = $2, method = $3, key_field = $4, sum_field = $5,
              window_from = $6, window_to = $7, source_rows = $8, lake_rows = $9, source_sum = $10, lake_sum = $11,
              days_compared = $12, days_diverged = $13, diff_days = $14, lost_rows = $15, notes = $16,
              source_ms = $17, finished_at = now()
        where id = $1`,
      [runId, ok ? 'match' : 'diverged', plan.method, plan.keyField?.key ?? null, plan.sumField?.key ?? null,
       lower, plan.upper, c.sourceRows, c.lakeRows, c.sourceSum, c.lakeSum,
       porDia ? c.daysCompared : null, porDia ? diffDays.length : null,
       JSON.stringify(diffDays.slice(0, 60)), lostRows, JSON.stringify(notes), sourceMs],
    )
    console.log(`[qualidade] ${ds.row.slug}: ${ok ? 'bate' : 'DIVERGE'} — fonte ${c.sourceRows} × lake ${c.lakeRows}` +
      `${porDia ? `, ${diffDays.length} de ${c.daysCompared} dia(s) diferentes` : ''}${lostRows ? `, ${lostRows} perdida(s)` : ''}.`)

    const tenantId = String(ds.row.tenant_id)
    const name = String(ds.row.name)
    if (!ok) {
      const dif = c.lakeRows - c.sourceRows
      const lines = [
        `Conjunto ${ds.row.slug}.`,
        `Fonte ${fmt(c.sourceRows)} linhas × lake ${fmt(c.lakeRows)} (${dif > 0 ? '+' : ''}${fmt(dif)} no lake).`,
      ]
      if (plan.sumField && !sameSum(c.sourceSum, c.lakeSum)) {
        lines.push(`Soma de ${plan.sumField.key}: fonte ${fmt(c.sourceSum)} × lake ${fmt(c.lakeSum)}.`)
      }
      if (lostRows) {
        lines.push(`${fmt(lostRows)} linha(s) da fonte nunca entram no lake: ${plan.lostCheck!.map((x) => x.key).join(' e ')} vazio(s).`)
      }
      if (diffDays.length) {
        const amostra = diffDays.slice(0, 5)
          .map((d) => `${fmtDia(d.day)} (fonte ${fmt(d.sourceRows)} × lake ${fmt(d.lakeRows)})`).join('; ')
        lines.push(`Dias diferentes: ${diffDays.length} de ${c.daysCompared}. ${amostra}${diffDays.length > 5 ? '; …' : ''}.`)
      }
      lines.push('Veja em Operar › Qualidade dos dados.')
      await notify(tenantId, { key: `reconcile:diverged:${datasetId}`, kind: 'reconcile-diverged', title: `Conciliação divergente: ${name}`, lines })
    } else {
      // Voltou a bater depois de divergir ou falhar: quem recebeu o alerta
      // precisa saber que o assunto fechou, senão o aviso velho fica aberto.
      const antes = (await db.query(
        `select status from reconcile_runs
          where dataset_id = $1 and id <> $2 and status in ('match', 'diverged', 'error')
          order by created_at desc limit 1`,
        [datasetId, runId],
      )).rows[0]
      if (antes && antes.status !== 'match') {
        await notify(tenantId, {
          key: `reconcile:resolved:${datasetId}:${runId}`,
          kind: 'reconcile-resolved',
          title: `Conciliação voltou a bater: ${name}`,
          lines: [`Conjunto ${ds.row.slug}: fonte e lake com ${fmt(c.sourceRows)} linhas.`],
        })
      }
    }
  } catch (e) {
    await finishWithError(runId, datasetId, (e as Error).message)
  }
}

// ── Rotina diária ────────────────────────────────────────────────────────
/**
 * Escolhe, uma vez por dia, um conjunto de cada faixa (pequeno, médio,
 * grande) e pede a conciliação. Gira: o escolhido é o que está há mais tempo
 * sem conferência, com os oficiais na frente — assim todo conjunto passa pela
 * conciliação, e o que vale para a diretoria passa primeiro.
 *
 * Idempotente no dia: se já houve escolha hoje, não escolhe de novo — o
 * agendador pode chamar a cada hora e um reinício no meio do dia não duplica.
 */
export async function runDailyPick(now: Date = new Date()): Promise<string[]> {
  if (!isDbAvailable()) return []
  const inicio = new Date(now)
  inicio.setHours(0, 0, 0, 0)
  const ja = (await db.query(
    `select 1 from reconcile_runs where trigger = 'daily' and created_at >= $1 limit 1`, [inicio],
  )).rowCount
  if (ja) return []

  const candidatos = (await db.query(
    `select d.id, d.slug, d.kind, d.sync_mode, d.connection_id, d.incremental_key, d.row_count, d.official,
            (select max(r.created_at) from reconcile_runs r where r.dataset_id = d.id) as last_rec,
            (select coalesce(json_agg(json_build_object('key', f.key, 'sourceColumn', f.source_column, 'type', f.type)), '[]')
               from dataset_fields f where f.dataset_id = d.id) as fields
       from datasets d
      where d.kind <> 'derived' and d.sync_mode in ('snapshot', 'incremental')
        -- 'manual' é congelado de propósito: a carga antes da conferência
        -- desfaria o congelamento sem ninguém ter pedido.
        and d.sync_cadence <> 'manual'
        -- Pausado por falhas seguidas: a carga antes da conferência só
        -- repetiria o erro. A pausa já tem o próprio alerta.
        and d.sync_paused_reason is null
        and d.last_sync_at is not null`,
  )).rows.filter((r) => !ineligibleReason({
    kind: String(r.kind), syncMode: String(r.sync_mode), incrementalKey: r.incremental_key ?? null,
    connectorKind: getConnector(String(r.connection_id))?.kind ?? null,
    fields: r.fields as PlanDataset['fields'],
  }))

  const ordem = (a: Record<string, any>, b: Record<string, any>) => {
    if (!!a.official !== !!b.official) return a.official ? -1 : 1
    const la = a.last_rec ? new Date(a.last_rec).getTime() : 0
    const lb = b.last_rec ? new Date(b.last_rec).getTime() : 0
    if (la !== lb) return la - lb // nunca conferido (0) primeiro
    return String(a.slug).localeCompare(String(b.slug))
  }
  const escolhidos: string[] = []
  for (const faixa of ['small', 'medium', 'large'] as ReconcileBand[]) {
    const da = candidatos.filter((r) => bandOf(r.row_count == null ? null : Number(r.row_count), rules()) === faixa).sort(ordem)
    const alvo = da[0]
    if (!alvo) continue
    try {
      await requestReconcile(String(alvo.id), 'daily', 'rotina diária')
      escolhidos.push(String(alvo.slug))
    } catch (e) {
      console.warn(`[qualidade] escolha diária: ${alvo.slug} não entrou (${(e as Error).message}).`)
    }
  }
  if (escolhidos.length) {
    console.log(`[qualidade] escolha do dia (${timestampLocal(now).slice(0, 10)}): ${escolhidos.join(', ')}.`)
  }
  return escolhidos
}

/**
 * Conferências que estavam esperando ou rodando quando o processo morreu. A
 * fila de cargas é memória do processo: depois de um reinício ninguém mais vai
 * rodá-las, e sem isto ficariam "na fila" para sempre — e o índice de uma
 * pendente por conjunto bloquearia o próximo pedido.
 */
export async function closeOrphanReconciles(): Promise<number> {
  const r = await db.query(
    `update reconcile_runs set status = 'error', finished_at = now(),
            error = 'Interrompida: o servidor reiniciou antes do fim da conferência. Peça de novo em "Conciliar agora".'
      where status in ('queued', 'running')`,
  )
  return r.rowCount ?? 0
}
