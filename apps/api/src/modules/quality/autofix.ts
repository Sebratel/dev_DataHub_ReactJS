// ─────────────────────────────────────────────────────────────────────────
// Correção automática da madrugada (pedido de 26/11/2026).
//
// É o "Corrigir" da tela Qualidade dos dados, feito sozinho: recarga completa
// do conjunto divergente e, na MESMA carga, a conferência com a fonte. Conferir
// sozinho nunca conserta — linha apagada na fonte, repetida ou faltando no lake
// só sai com a fonte relida inteira.
//
// Para não pesar na fonte nem prender a fila no expediente, a cota é por faixa
// e por noite, no mesmo espírito da escolha diária: até 3 pequenos, 2 médios e
// 1 grande (DQ_AUTOFIX_*). Entram na fila do menor para o maior, então a
// recarga demorada do grande vai por último e não segura os outros.
//
// Só entra o que uma recarga de fato conserta:
//   • a última conferência DIVERGIU (erro de conferência não é divergência);
//   • modo incremental — o snapshot já relê tudo a cada carga;
//   • a identidade é única na fonte (com identidade repetida a compactação
//     guarda uma por identidade e continuaria divergindo) e nenhuma linha da
//     fonte fica fora por chave vazia (essas nunca entram, nem na recarga);
//   • não houve correção automática do mesmo conjunto nos últimos 7 dias: se a
//     recarga não resolveu, o defeito não é de carga e repetir toda noite só
//     relê a fonte para chegar ao mesmo lugar. Fica para alguém analisar.
// E fica fora o conjunto com PISO ("só os últimos N dias" ou "desde"): a
// recarga respeita o piso e substitui o lake, então o histórico acumulado
// antes dele seria apagado sem ninguém pedir (QLD-05, ainda aberto).
// ─────────────────────────────────────────────────────────────────────────
import type { ReconcileBand } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { getConnector } from '../../connectors/registry.js'
import { currentSync } from '../sync/ingest.js'
import { requestReconcile, rules } from './reconcile.js'
import {
  AUTOFIX_COOLDOWN_DAYS, bandOf, ineligibleReason, timestampLocal, type PlanDataset, type PlanRules,
} from './reconcilePlan.js'

export interface AutofixQuotas { small: number; medium: number; large: number }

export interface AutofixCandidate {
  id: string
  slug: string
  official: boolean
  rowCount: number | null
  /** Hora da última conferência (a que divergiu). */
  lastRunAt: Date
  lastAutofixAt: Date | null
  dupIdentity: number | null
  lostRows: number | null
  /** Carregando agora: zerar o watermark seria desfeito no fim desta carga. */
  running: boolean
  /** Tem piso (sync_since ou sync_since_days): a recarga cortaria o histórico. */
  hasFloor: boolean
}

export interface AutofixChoice {
  chosen: { candidate: AutofixCandidate; band: ReconcileBand }[]
  skipped: { slug: string; reason: string }[]
}

const ORDEM_FAIXAS: ReconcileBand[] = ['small', 'medium', 'large']

/**
 * Escolhe quem corrigir hoje. Pura: recebe os divergentes e devolve a lista em
 * ordem de execução (pequenos, médios, grande) e o motivo de quem ficou fora.
 * Dentro da faixa: oficiais primeiro, depois a divergência mais antiga.
 */
export function chooseAutofix(
  candidates: AutofixCandidate[], r: PlanRules, quotas: AutofixQuotas, now: Date,
): AutofixChoice {
  const skipped: AutofixChoice['skipped'] = []
  const limite = now.getTime() - AUTOFIX_COOLDOWN_DAYS * 86_400_000
  const aptos = candidates.filter((c) => {
    if (c.hasFloor) {
      skipped.push({ slug: c.slug, reason: 'tem piso de datas: a recarga apagaria o histórico anterior a ele' })
      return false
    }
    if ((c.dupIdentity ?? 0) > 0) {
      skipped.push({ slug: c.slug, reason: 'identidade repetida na fonte: a recarga não resolve' })
      return false
    }
    if ((c.lostRows ?? 0) > 0) {
      skipped.push({ slug: c.slug, reason: 'linhas com chave vazia na fonte: nunca entram, nem na recarga' })
      return false
    }
    if (c.lastAutofixAt && c.lastAutofixAt.getTime() > limite) {
      skipped.push({ slug: c.slug, reason: `já corrigido automaticamente há menos de ${AUTOFIX_COOLDOWN_DAYS} dias` })
      return false
    }
    if (c.running) {
      skipped.push({ slug: c.slug, reason: 'carregando agora; fica para a próxima noite' })
      return false
    }
    return true
  })

  const ordem = (a: AutofixCandidate, b: AutofixCandidate) => {
    if (a.official !== b.official) return a.official ? -1 : 1
    const d = a.lastRunAt.getTime() - b.lastRunAt.getTime()
    return d || a.slug.localeCompare(b.slug)
  }
  const chosen: AutofixChoice['chosen'] = []
  for (const band of ORDEM_FAIXAS) {
    const da = aptos.filter((c) => bandOf(c.rowCount, r) === band).sort(ordem)
    const cota = quotas[band]
    for (const c of da.slice(0, cota)) chosen.push({ candidate: c, band })
    for (const c of da.slice(cota)) skipped.push({ slug: c.slug, reason: 'acima da cota da faixa nesta noite' })
  }
  return { chosen, skipped }
}

/** Divergentes que uma recarga pode consertar, com o que a escolha precisa. */
async function loadCandidates(): Promise<AutofixCandidate[]> {
  // O mesmo recorte da rotina diária: nada de calculado, 'manual' (congelado
  // de propósito) ou pausado (a carga só repetiria o erro).
  const rows = (await db.query(
    `select d.id, d.slug, d.kind, d.sync_mode, d.connection_id, d.incremental_key, d.row_count, d.official,
            d.sync_since, d.sync_since_days,
            (select coalesce(json_agg(json_build_object('key', f.key, 'sourceColumn', f.source_column, 'type', f.type)), '[]')
               from dataset_fields f where f.dataset_id = d.id) as fields,
            (select r.id from reconcile_runs r where r.dataset_id = d.id order by r.created_at desc limit 1) as last_run_id,
            (select max(r.created_at) from reconcile_runs r where r.dataset_id = d.id and r.trigger = 'autofix') as last_autofix
       from datasets d
      where d.kind <> 'derived' and d.sync_mode = 'incremental'
        and d.sync_cadence <> 'manual'
        and d.sync_paused_reason is null
        and d.last_sync_at is not null`,
  )).rows.filter((r) => r.last_run_id && !ineligibleReason({
    kind: String(r.kind), syncMode: String(r.sync_mode), incrementalKey: r.incremental_key ?? null,
    connectorKind: getConnector(String(r.connection_id))?.kind ?? null,
    fields: r.fields as PlanDataset['fields'],
  }))
  if (!rows.length) return []

  const runs = new Map((await db.query(
    `select id, status, created_at, dup_identity, lost_rows from reconcile_runs where id = any($1::uuid[])`,
    [rows.map((r) => String(r.last_run_id))],
  )).rows.map((x) => [String(x.id), x]))

  const rodando = currentSync()
  const out: AutofixCandidate[] = []
  for (const r of rows) {
    const run = runs.get(String(r.last_run_id))
    if (!run || run.status !== 'diverged') continue
    out.push({
      id: String(r.id),
      slug: String(r.slug),
      official: !!r.official,
      rowCount: r.row_count == null ? null : Number(r.row_count),
      lastRunAt: new Date(run.created_at),
      lastAutofixAt: r.last_autofix ? new Date(r.last_autofix) : null,
      dupIdentity: run.dup_identity == null ? null : Number(run.dup_identity),
      lostRows: run.lost_rows == null ? null : Number(run.lost_rows),
      running: rodando === String(r.id),
      hasFloor: r.sync_since != null || r.sync_since_days != null,
    })
  }
  return out
}

/**
 * A rotina da madrugada. Idempotente no dia: se já houve correção automática
 * hoje, não pede outra. Devolve os slugs que entraram na fila.
 */
export async function runNightlyAutofix(now: Date = new Date()): Promise<string[]> {
  if (!isDbAvailable() || !config.quality.autofix.enabled) return []
  const inicio = new Date(now)
  inicio.setHours(0, 0, 0, 0)
  const ja = (await db.query(
    `select 1 from reconcile_runs where trigger = 'autofix' and created_at >= $1 limit 1`, [inicio],
  )).rowCount
  if (ja) return []

  const { chosen, skipped } = chooseAutofix(await loadCandidates(), rules(), config.quality.autofix, now)
  const pedidos: string[] = []
  for (const { candidate: c, band } of chosen) {
    try {
      // Zera o watermark ANTES de pedir: a carga que a conferência pede lê o
      // watermark quando começa, e sem watermark ela relê a fonte inteira e
      // SUBSTITUI o lake (a mesma recarga do POST /datasets/:id/reload).
      await db.query(
        `update datasets set watermark = null, watermark_2 = null, updated_at = now() where id = $1`, [c.id],
      )
      await requestReconcile(c.id, 'autofix', 'correção automática')
      pedidos.push(c.slug)
      console.log(`[qualidade] correção automática: ${c.slug} (${band}) na fila — recarga completa e conferência.`)
    } catch (e) {
      // O watermark já foi zerado: a próxima carga do agendamento relê tudo
      // de qualquer jeito. Só a conferência fica para depois.
      console.warn(`[qualidade] correção automática: ${c.slug} não entrou (${(e as Error).message}).`)
    }
  }
  for (const s of skipped) console.log(`[qualidade] correção automática: ${s.slug} fora (${s.reason}).`)
  if (pedidos.length || skipped.length) {
    console.log(`[qualidade] correção automática de ${timestampLocal(now).slice(0, 10)}: ` +
      `${pedidos.length} na fila, ${skipped.length} fora.`)
  }
  return pedidos
}
