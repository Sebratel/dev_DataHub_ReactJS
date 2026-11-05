// Operar › Qualidade dos dados: conciliação fonte × lake (D-QLD-3) e o canal
// de alertas (P-QLD-2 / MON-03).
//
// Permissões, rota por rota (conferidas pelo dev/permissionsSmoke.ts):
//   • ver resultados e alertas: admin;
//   • "Conciliar agora": admin — é operação, como "Sincronizar agora": dispara
//     uma carga e uma leitura na fonte, sem mudar regra nenhuma;
//   • cadastrar e testar o webhook: master. O endereço é para onde os avisos
//     de defeito vão; trocá-lo em silêncio desviaria os alertas de todos.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type {
  ReconcileRun, QualityOverview, QualityDatasetRow, AlertSettingsView, AlertEventRow, SyncRuleField, DatasetCheckRow,
} from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { encryptSecret, decryptSecret, hasSecret } from '../../core/crypto.js'
import { getConnector } from '../../connectors/registry.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { alertText, postWebhook, validateWebhookUrl, webhookHint } from '../alerts/notify.js'
import { requestReconcile, rules } from './reconcile.js'
import { bandOf, ineligibleReason } from './reconcilePlan.js'

export const qualityRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
const masterOnly = [requireAuth({ role: 'master' }), requireDb]

// A linha da conciliação já com os rótulos dos campos (a tela mostra o nome
// que as pessoas reconhecem, não a coluna física).
const RUN_SELECT = `
  select r.*, d.slug, d.name,
         (select json_build_object('key', f.key, 'label', coalesce(nullif(f.label, ''), f.key))
            from dataset_fields f where f.dataset_id = r.dataset_id and f.key = r.key_field limit 1) as key_label,
         (select json_build_object('key', f.key, 'label', coalesce(nullif(f.label, ''), f.key))
            from dataset_fields f where f.dataset_id = r.dataset_id and f.key = r.sum_field limit 1) as sum_label
    from reconcile_runs r join datasets d on d.id = r.dataset_id`

const num = (v: unknown) => (v == null ? null : Number(v))
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())
const campo = (label: unknown, key: unknown): SyncRuleField | null =>
  label ? (label as SyncRuleField) : key ? { key: String(key), label: String(key) } : null

function mapRun(r: Record<string, any>): ReconcileRun {
  return {
    id: String(r.id), datasetId: String(r.dataset_id), slug: String(r.slug), name: String(r.name),
    trigger: r.trigger, band: r.band ?? null, status: r.status, method: r.method ?? null,
    keyField: campo(r.key_label, r.key_field), sumField: campo(r.sum_label, r.sum_field),
    windowFrom: r.window_from ?? null, windowTo: r.window_to ?? null,
    sourceRows: num(r.source_rows), lakeRows: num(r.lake_rows),
    sourceSum: num(r.source_sum), lakeSum: num(r.lake_sum),
    daysCompared: num(r.days_compared), daysDiverged: num(r.days_diverged),
    diffDays: (r.diff_days as ReconcileRun['diffDays'] | null) ?? [],
    lostRows: num(r.lost_rows), dupIdentity: num(r.dup_identity), notes: (r.notes as string[] | null) ?? [],
    error: r.error ?? null, requestedBy: r.requested_by ?? null, sourceMs: num(r.source_ms),
    createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  }
}

// Todos os conjuntos de FONTE, com a última conferência de cada um. Os que
// não podem ser conciliados também aparecem, com o motivo: "por que este não
// está aqui?" precisa de resposta na própria tela.
qualityRouter.get('/overview', ...adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select d.id, d.slug, d.name, d.kind, d.official, d.row_count, d.sync_mode, d.connection_id, d.incremental_key,
            (select coalesce(json_agg(json_build_object('key', f.key, 'sourceColumn', f.source_column, 'type', f.type)), '[]')
               from dataset_fields f where f.dataset_id = d.id) as fields,
            (select r.id from reconcile_runs r where r.dataset_id = d.id order by r.created_at desc limit 1) as last_run_id
       from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind <> 'derived'
      order by d.name`,
    [req.user!.tenant],
  )).rows
  const ids = rows.map((r) => r.last_run_id).filter(Boolean)
  const runs = ids.length
    ? new Map((await db.query(`${RUN_SELECT} where r.id = any($1::uuid[])`, [ids])).rows.map((r) => [String(r.id), mapRun(r)]))
    : new Map<string, ReconcileRun>()

  const datasets: QualityDatasetRow[] = rows.map((r) => ({
    id: String(r.id), slug: String(r.slug), name: String(r.name), official: !!r.official,
    rowCount: num(r.row_count), band: bandOf(num(r.row_count), rules()), mode: r.sync_mode,
    ineligible: ineligibleReason({
      kind: String(r.kind), syncMode: String(r.sync_mode), incrementalKey: r.incremental_key ?? null,
      connectorKind: getConnector(String(r.connection_id))?.kind ?? null, fields: r.fields,
    }),
    lastRun: r.last_run_id ? runs.get(String(r.last_run_id)) ?? null : null,
  }))
  // Verificações contínuas que estão falhando agora — fontes E calculados (o
  // prazo vale para os dois; a conciliação, só para fontes).
  const failingChecks: DatasetCheckRow[] = (await db.query(
    `select c.*, d.slug, d.name, d.kind from dataset_checks c
       join datasets d on d.id = c.dataset_id join tenants t on t.id = d.tenant_id
      where t.slug = $1 and c.status = 'fail'
      order by c.since`,
    [req.user!.tenant],
  )).rows.map((c) => ({
    datasetId: String(c.dataset_id), slug: String(c.slug), name: String(c.name),
    kind: c.kind === 'derived' ? 'derived' : 'source', check: c.check_name, status: c.status,
    detail: c.detail ?? null, since: iso(c.since)!, checkedAt: iso(c.checked_at)!,
  }))
  const body: QualityOverview = {
    datasets,
    failingChecks,
    rules: { ...rules(), reconcileHour: config.quality.reconcileHour },
  }
  res.json(body)
})

// Histórico de um conjunto: as últimas 30 conferências.
qualityRouter.get('/datasets/:id/reconciliations', ...adminOnly, async (req, res) => {
  const runs = (await db.query(
    `${RUN_SELECT} where r.dataset_id = $1 order by r.created_at desc limit 30`, [req.params.id],
  )).rows.map(mapRun)
  res.json({ runs })
})

qualityRouter.post('/datasets/:id/reconcile', ...adminOnly, async (req, res) => {
  const ds = (await db.query(`select slug from datasets where id = $1`, [req.params.id])).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  try {
    const r = await requestReconcile(req.params.id, 'manual', req.user!.email)
    if (!r.already) await audit(req, 'quality.reconcile', { type: 'dataset', id: String(ds.slug) })
    res.status(202).json({ id: r.id, alreadyQueued: r.already })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ── Alertas ──────────────────────────────────────────────────────────────
function settingsView(s: Record<string, any> | undefined): AlertSettingsView {
  return {
    configured: !!s?.webhook_enc, hint: s?.webhook_hint ?? null, enabled: s ? !!s.enabled : true,
    lastTestAt: iso(s?.last_test_at), lastTestOk: s?.last_test_ok ?? null, lastTestError: s?.last_test_error ?? null,
    updatedBy: s?.updated_by ?? null, updatedAt: iso(s?.updated_at),
  }
}

async function tenantId(slug: string): Promise<string> {
  return String((await db.query(`select id from tenants where slug = $1`, [slug])).rows[0].id)
}

qualityRouter.get('/alerts', ...adminOnly, async (req, res) => {
  const t = await tenantId(req.user!.tenant)
  const s = (await db.query(`select * from alert_settings where tenant_id = $1`, [t])).rows[0]
  const events: AlertEventRow[] = (await db.query(
    `select id, kind, title, body, status, error, created_at from alert_events
      where tenant_id = $1 order by created_at desc limit 50`, [t],
  )).rows.map((e) => ({
    id: String(e.id), kind: e.kind, title: e.title, body: e.body, status: e.status,
    error: e.error ?? null, createdAt: iso(e.created_at)!,
  }))
  res.json({ settings: settingsView(s), events })
})

// Grava o canal. `webhookUrl` vazio remove; ausente mantém o atual (a tela
// nunca recebe o endereço de volta, então não tem como reenviá-lo).
qualityRouter.put('/alerts', ...masterOnly, async (req, res) => {
  const b = (req.body ?? {}) as { webhookUrl?: unknown; enabled?: unknown }
  try {
    const t = await tenantId(req.user!.tenant)
    let enc: string | null | undefined
    let hint: string | null | undefined
    if (b.webhookUrl !== undefined) {
      const raw = String(b.webhookUrl ?? '').trim()
      if (raw) {
        if (!hasSecret()) throw new Error('CONNECTIONS_SECRET ausente: sem ela não há como guardar o webhook cifrado.')
        const url = validateWebhookUrl(raw)
        enc = encryptSecret(url)
        hint = webhookHint(url)
      } else {
        enc = null
        hint = null
      }
    }
    const enabled = b.enabled === undefined ? null : !!b.enabled
    await db.query(
      `insert into alert_settings (tenant_id, webhook_enc, webhook_hint, enabled, updated_by, updated_at)
       values ($1, $2, $3, coalesce($4, true), $5, now())
       on conflict (tenant_id) do update set
         webhook_enc = case when $6 then excluded.webhook_enc else alert_settings.webhook_enc end,
         webhook_hint = case when $6 then excluded.webhook_hint else alert_settings.webhook_hint end,
         -- Endereço novo: o teste anterior era de outro destino e não vale mais.
         last_test_at = case when $6 then null else alert_settings.last_test_at end,
         last_test_ok = case when $6 then null else alert_settings.last_test_ok end,
         last_test_error = case when $6 then null else alert_settings.last_test_error end,
         enabled = coalesce($4, alert_settings.enabled),
         updated_by = excluded.updated_by, updated_at = now()`,
      [t, enc ?? null, hint ?? null, enabled, req.user!.email, b.webhookUrl !== undefined],
    )
    await audit(req, 'quality.alerts', { type: 'alert_settings', id: req.user!.tenant },
      { webhook: b.webhookUrl === undefined ? 'mantido' : enc ? hint : 'removido', enabled })
    const s = (await db.query(`select * from alert_settings where tenant_id = $1`, [t])).rows[0]
    res.json({ settings: settingsView(s) })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Manda uma mensagem de teste e guarda o resultado — é o que diz se o
// cadastro presta antes de um defeito de verdade depender dele.
qualityRouter.post('/alerts/test', ...masterOnly, async (req, res) => {
  const t = await tenantId(req.user!.tenant)
  const s = (await db.query(`select webhook_enc from alert_settings where tenant_id = $1`, [t])).rows[0]
  if (!s?.webhook_enc) return res.status(400).json({ error: 'Cadastre o webhook antes de testar.' })
  let erro: string | null
  try {
    erro = await postWebhook(decryptSecret(String(s.webhook_enc)), alertText('Teste do canal de alertas', [
      `Enviado por ${req.user!.email}. Se chegou aqui, os avisos de qualidade dos dados também chegam.`,
    ]))
  } catch (e) {
    erro = `Não foi possível ler o webhook cadastrado: ${(e as Error).message}`
  }
  await db.query(
    `update alert_settings set last_test_at = now(), last_test_ok = $2, last_test_error = $3 where tenant_id = $1`,
    [t, !erro, erro],
  )
  await audit(req, 'quality.alerts-test', { type: 'alert_settings', id: req.user!.tenant }, { ok: !erro })
  if (erro) return res.status(502).json({ error: `O webhook recusou o teste: ${erro}` })
  res.json({ ok: true })
})
