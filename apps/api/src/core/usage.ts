// ─────────────────────────────────────────────────────────────────────────
// Registro de USO (MON-01 e D-DSP-2 do comitê). Ver migration 040.
//
// Um upsert por evento numa linha diária com contador. Quando o contador
// nasce (1º uso do dia daquela pessoa, naquele recurso, por aquele caminho), o
// evento vai também para a Auditoria. Assim a Auditoria responde "quem abriu o
// quê" sem uma linha por widget de painel.
//
// Best-effort, como audit(): falha aqui nunca derruba a consulta da pessoa.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../db/pool.js'

export type UsageVia = 'query' | 'export' | 'notebook' | 'dashboard' | 'ai' | 'api'
export type UsageResource = 'dataset' | 'dashboard' | 'notebook'

// O "dia" do uso é o dia daqui, não o de Greenwich: às 21h de Brasília o UTC já
// virou, e o acesso da noite contaria no dia seguinte.
const FUSO = 'America/Sao_Paulo'

export interface UsageEvent {
  /** Slug do tenant. */
  tenant: string
  /** E-mail da pessoa, ou `token:<id>` na API pública. */
  actor: string
  resourceType: UsageResource
  resourceId: string
  via: UsageVia
  /** Vai para a Auditoria no 1º uso do dia. Sem ela, só conta. */
  audit?: { action: string; resource: string; detail?: Record<string, unknown>; ip?: string | null }
}

export async function recordUsage(e: UsageEvent): Promise<void> {
  if (!isDbAvailable()) return
  try {
    const r = await db.query(
      `insert into usage_daily (tenant_id, day, resource_type, resource_id, actor, via)
       select t.id, (now() at time zone '${FUSO}')::date, $2, $3, $4, $5
         from tenants t where t.slug = $1
       on conflict (tenant_id, day, resource_type, resource_id, actor, via)
       do update set hits = usage_daily.hits + 1, last_at = now()
       returning hits`,
      [e.tenant, e.resourceType, e.resourceId, e.actor, e.via],
    )
    if (!e.audit || Number(r.rows[0]?.hits) !== 1) return
    await db.query(
      `insert into audit_logs (tenant_id, user_email, action, resource_type, resource_id, detail, ip)
       select t.id, $2, $3, $4, $5, $6, $7 from tenants t where t.slug = $1`,
      [e.tenant, e.actor, e.audit.action, e.resourceType, e.audit.resource,
       JSON.stringify({ via: e.via, ...(e.audit.detail ?? {}) }), e.audit.ip ?? null],
    )
  } catch (err) {
    console.warn(`[uso] falha ao registrar ${e.resourceType} ${e.resourceId}: ${(err as Error).message}`)
  }
}

export interface UsageSummary {
  /** Desde quando o hub registra uso. Antes disso, "sem uso" não quer dizer nada. */
  trackingSince: string | null
  lastAccessAt: string | null
  /** Últimos 30 dias. */
  last30: { people: number; tokens: number; hits: number; byVia: Record<string, number> }
}

/** Resumo de uso de um recurso, para a tela do dono/admin. */
export async function usageSummary(
  tenant: string, resourceType: UsageResource, resourceId: string,
): Promise<UsageSummary> {
  const desde = (await db.query(
    `select min(u.day)::text as d from usage_daily u join tenants t on t.id = u.tenant_id where t.slug = $1`,
    [tenant],
  )).rows[0]?.d ?? null
  const rows = (await db.query(
    `select u.actor, u.via, sum(u.hits)::int as hits, max(u.last_at) as last_at
       from usage_daily u join tenants t on t.id = u.tenant_id
      where t.slug = $1 and u.resource_type = $2 and u.resource_id = $3
        and u.day > (now() at time zone '${FUSO}')::date - 30
      group by u.actor, u.via`,
    [tenant, resourceType, resourceId],
  )).rows
  const ultimo = (await db.query(
    `select max(u.last_at) as m from usage_daily u join tenants t on t.id = u.tenant_id
      where t.slug = $1 and u.resource_type = $2 and u.resource_id = $3`,
    [tenant, resourceType, resourceId],
  )).rows[0]?.m ?? null

  const pessoas = new Set<string>()
  const tokens = new Set<string>()
  const byVia: Record<string, number> = {}
  let hits = 0
  for (const r of rows) {
    const actor = String(r.actor)
    ;(actor.startsWith('token:') ? tokens : pessoas).add(actor)
    byVia[String(r.via)] = (byVia[String(r.via)] ?? 0) + Number(r.hits)
    hits += Number(r.hits)
  }
  return {
    trackingSince: desde,
    lastAccessAt: ultimo ? new Date(ultimo).toISOString() : null,
    last30: { people: pessoas.size, tokens: tokens.size, hits, byVia },
  }
}
