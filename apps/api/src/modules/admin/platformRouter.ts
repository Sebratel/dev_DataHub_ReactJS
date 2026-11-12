// ─────────────────────────────────────────────────────────────────────────
// Operar › Saúde da plataforma — a saúde do Data Hub numa tela só, para admin.
//
//   GET /api/v1/platform/health  (admin) — a tela inteira
//   GET /api/v1/platform/badge   (admin) — o sino do cabeçalho (leve)
//
// Existe porque a pergunta "está tudo bem?" pedia umas dez telas (MON-14): a
// fila numa, o disco noutra, os calculados um a um, as conferências em outra.
// E porque o canal escolhido para avisar é a própria plataforma — o admin
// abre o Data Hub e vê, sem depender de e-mail nem chat.
//
// "Precisa de atenção agora" é montado do ESTADO atual, não de eventos: cada
// problema sai da lista sozinho quando a causa é resolvida. Um evento ("a
// carga falhou às 3 h") fica no histórico de alertas; o problema ("o conjunto
// está pausado") fica aqui enquanto existir.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { statfsSync } from 'node:fs'
import type { PlatformHealth, PlatformProblem, PlatformRun, PlatformBadge } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { diskUsage, LAKE_ROOT } from '../../core/lake.js'
import { engineLoad } from '../query/duck.js'
import { currentSync, pendingSyncs } from '../sync/ingest.js'
import { requireAuth } from '../auth/middleware.js'

export const platformRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())
const curto = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

const CHECK: Record<string, { title: string; severity: PlatformProblem['severity']; area: PlatformProblem['area'] }> = {
  stale: { title: 'atrasado', severity: 'warn', area: 'carga' },
  volume: { title: 'volume caiu', severity: 'crit', area: 'qualidade' },
  identity: { title: 'identidade vazia ou repetida', severity: 'crit', area: 'qualidade' },
}

/** Uso do volume do lake só pelo statfs — barato, para o sino. */
function diskPercent(): number | null {
  try {
    const fs = statfsSync(LAKE_ROOT)
    const total = fs.blocks * fs.bsize
    return total > 0 ? Math.round(((total - fs.bavail * fs.bsize) / total) * 1000) / 10 : null
  } catch { return null }
}

/** Tudo que precisa de atenção agora, dos mais graves para os mais leves. */
export async function platformProblems(tenant: string): Promise<PlatformProblem[]> {
  const out: PlatformProblem[] = []

  // ── Verificações contínuas (prazo, volume, identidade) ──────────────
  for (const c of (await db.query(
    `select c.dataset_id, c.check_name, c.detail, c.since, d.slug, d.name
       from dataset_checks c join datasets d on d.id = c.dataset_id join tenants t on t.id = d.tenant_id
      where t.slug = $1 and c.status = 'fail'`, [tenant],
  )).rows) {
    const k = CHECK[c.check_name] ?? { title: c.check_name, severity: 'warn', area: 'qualidade' }
    out.push({
      id: `check:${c.check_name}:${c.dataset_id}`, severity: k.severity, area: k.area,
      title: `${c.name}: ${k.title}`, detail: curto(c.detail), since: iso(c.since), link: '/admin/quality',
    })
  }

  // ── Cargas pausadas por falhas seguidas ─────────────────────────────
  for (const d of (await db.query(
    `select d.id, d.slug, d.name, d.sync_paused_reason, d.updated_at
       from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.sync_paused_reason is not null`, [tenant],
  )).rows) {
    out.push({
      id: `paused:${d.id}`, severity: 'crit', area: 'carga',
      title: `${d.name}: carga pausada`, detail: curto(d.sync_paused_reason), since: iso(d.updated_at),
      link: `/datasets/${d.slug}`,
    })
  }

  // ── Última carga com erro e nenhum sucesso depois (fontes e calculados) ─
  // Pausados ficam de fora: já estão na lista acima, com o motivo.
  for (const r of (await db.query(
    `select d.id, d.slug, d.name, d.kind, r.error, r.finished_at
       from datasets d join tenants t on t.id = d.tenant_id
       join sync_runs r on r.id = (
         select s.id from sync_runs s
          where s.dataset_id = d.id and s.status in ('done', 'error')
          order by s.started_at desc limit 1
       )
      where t.slug = $1 and d.sync_paused_reason is null and r.status = 'error'`, [tenant],
  )).rows) {
    out.push({
      id: `sync-error:${r.id}`, severity: 'warn', area: 'carga',
      title: `${r.name}: ${r.kind === 'derived' ? 'materialização' : 'carga'} falhou`,
      detail: curto(r.error) || 'A última execução terminou com erro.', since: iso(r.finished_at),
      link: `/datasets/${r.slug}`,
    })
  }

  // ── Última conciliação divergente ou não concluída ──────────────────
  for (const r of (await db.query(
    `select d.id, d.slug, d.name, x.status, x.error, x.source_rows, x.lake_rows, x.finished_at
       from datasets d join tenants t on t.id = d.tenant_id
       join reconcile_runs x on x.id = (
         select rr.id from reconcile_runs rr
          where rr.dataset_id = d.id and rr.status in ('match', 'diverged', 'error')
          order by rr.created_at desc limit 1
       )
      where t.slug = $1 and x.status in ('diverged', 'error')`, [tenant],
  )).rows) {
    const diverge = r.status === 'diverged'
    out.push({
      id: `reconcile:${r.id}`, severity: diverge ? 'crit' : 'warn', area: 'qualidade',
      title: `${r.name}: ${diverge ? 'conciliação divergente' : 'conciliação não concluída'}`,
      detail: diverge
        ? `Fonte ${Number(r.source_rows).toLocaleString('pt-BR')} linhas × lake ${Number(r.lake_rows).toLocaleString('pt-BR')}.`
        : curto(r.error),
      since: iso(r.finished_at), link: '/admin/quality',
    })
  }

  // ── Envio ao Databricks falhando ────────────────────────────────────
  for (const r of (await db.query(
    `select d.id, d.slug, d.name, x.error_message, x.finished_at
       from datasets d join tenants t on t.id = d.tenant_id
       join databricks_sync_runs x on x.id = (
         select b.id from databricks_sync_runs b
          where b.dataset_id = d.id and b.status in ('SUCCESS', 'FAILED')
          order by b.started_at desc limit 1
       )
      where t.slug = $1 and d.databricks_enabled and x.status = 'FAILED'`, [tenant],
  )).rows) {
    out.push({
      id: `databricks:${r.id}`, severity: 'warn', area: 'integracao',
      title: `${r.name}: envio ao Databricks falhou`, detail: curto(r.error_message) || 'O último envio falhou.',
      since: iso(r.finished_at), link: `/datasets/${r.slug}`,
    })
  }

  // ── Verificações de saúde (endpoints) fora do ar ────────────────────
  for (const h of (await db.query(
    `select h.id, h.name, h.url, m.status, m.error, m.created_at
       from health_checks h join tenants t on t.id = h.tenant_id
       join api_call_metrics m on m.id = (
         select a.id from api_call_metrics a
          where a.check_type = 'healthcheck' and a.endpoint = h.url
          order by a.created_at desc limit 1
       )
      where t.slug = $1 and h.enabled and not m.ok`, [tenant],
  )).rows) {
    out.push({
      id: `health:${h.id}`, severity: 'crit', area: 'integracao',
      title: `${h.name}: fora do ar`,
      detail: `${h.url} respondeu ${h.status ? `HTTP ${h.status}` : 'com erro'}${h.error ? ` (${curto(h.error, 120)})` : ''}.`,
      // Sem link: a verificação de saúde mora na própria tela de saúde.
      since: iso(h.created_at), link: null,
    })
  }

  // ── Disco do lake ───────────────────────────────────────────────────
  const pct = diskPercent()
  if (pct != null && pct >= config.sync.diskWarnPercent) {
    out.push({
      id: 'disk', severity: 'crit', area: 'infraestrutura',
      title: `Disco do lake em ${pct}%`,
      detail: `Acima do limite de aviso (${config.sync.diskWarnPercent}%). Cargas grandes usam espaço temporário além disso.`,
      // Os maiores conjuntos (onde o espaço foi parar) ficam em Padronizar atualização.
      since: null, link: '/admin/autotune',
    })
  }

  const peso = { crit: 0, warn: 1 }
  return out.sort((a, b) => peso[a.severity] - peso[b.severity] || String(a.since ?? '').localeCompare(String(b.since ?? '')))
}

async function unseenAlerts(tenant: string): Promise<number> {
  return Number((await db.query(
    `select count(*)::int as n from alert_events e join tenants t on t.id = e.tenant_id
      where t.slug = $1 and e.seen_at is null`, [tenant],
  )).rows[0]?.n ?? 0)
}

platformRouter.get('/badge', ...adminOnly, async (req, res) => {
  const problems = await platformProblems(req.user!.tenant)
  const body: PlatformBadge = {
    problems: problems.length,
    crit: problems.filter((p) => p.severity === 'crit').length,
    unseenAlerts: await unseenAlerts(req.user!.tenant),
  }
  res.json(body)
})

platformRouter.get('/health', ...adminOnly, async (req, res) => {
  const tenant = req.user!.tenant
  const problems = await platformProblems(tenant)

  const porStatus = (await db.query(
    `select r.status, count(*)::int as n from sync_runs r
       join datasets d on d.id = r.dataset_id join tenants t on t.id = d.tenant_id
      where t.slug = $1 and r.started_at > now() - interval '24 hours'
      group by r.status`, [tenant],
  )).rows
  const n = (s: string) => Number(porStatus.find((r) => r.status === s)?.n ?? 0)
  const failures: PlatformRun[] = (await db.query(
    `select r.id, r.dataset_id, r.mode, r.status, r.rows, r.error, r.started_at, r.finished_at, d.slug, d.name, d.kind
       from sync_runs r join datasets d on d.id = r.dataset_id join tenants t on t.id = d.tenant_id
      where t.slug = $1 and r.started_at > now() - interval '24 hours' and r.status = 'error'
      order by r.started_at desc limit 50`, [tenant],
  )).rows.map((r) => ({
    id: String(r.id), datasetId: String(r.dataset_id), slug: String(r.slug), name: String(r.name),
    kind: r.kind === 'derived' ? 'derived' : 'source', mode: String(r.mode), status: String(r.status),
    rows: r.rows == null ? null : Number(r.rows), error: r.error ? curto(r.error, 500) : null,
    startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at),
  }))

  let disk: PlatformHealth['disk'] = null
  try {
    const u = diskUsage()
    disk = {
      usedPercent: u.usedPercent, warnPercent: config.sync.diskWarnPercent, totalBytes: u.totalBytes,
      freeBytes: u.freeBytes, lakeBytes: u.lakeBytes, stagingBytes: u.stagingBytes,
    }
  } catch { /* volume indisponível: a tela mostra "sem leitura" */ }

  const rodando = currentSync()
  const ds = rodando
    ? (await db.query(`select slug, name from datasets where id = $1`, [rodando])).rows[0]
    : null

  const body: PlatformHealth = {
    checkedAt: new Date().toISOString(),
    problems,
    runs24h: {
      total: porStatus.reduce((a, r) => a + Number(r.n), 0),
      done: n('done'), error: n('error'), cancelled: n('cancelled'), running: n('running'), failures,
    },
    disk,
    engine: { ...engineLoad(), maxNormal: config.duck.maxConcurrency, maxAdhoc: config.duck.maxAdhocConcurrency },
    queue: { running: ds ? { slug: String(ds.slug), name: String(ds.name) } : null, waiting: pendingSyncs().length },
    unseenAlerts: await unseenAlerts(tenant),
  }
  res.json(body)
})
