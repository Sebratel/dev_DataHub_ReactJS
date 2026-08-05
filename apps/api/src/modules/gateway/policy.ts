// ─────────────────────────────────────────────────────────────────────────
// Política do gateway — o que roda no caminho de TODA requisição pública.
//
// Três responsabilidades, nesta ordem: identificar o consumidor, aplicar os
// limites dele, e registrar a chamada com atribuição correta.
//
// Rate limit e quota são coisas diferentes de propósito:
//   • rate limit (por minuto) protege o MOTOR de um pico — vive em memória,
//     porque precisa ser barato e pode reiniciar junto com o processo;
//   • quota (por dia) é contrato comercial com o consumidor — vive no banco,
//     porque um redeploy não pode zerar o teto de ninguém.
// ─────────────────────────────────────────────────────────────────────────
import { createHash, randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface Consumer {
  id: string
  name: string
  tenantId: string
  tenantSlug: string
  datasetSlugs: string[]
  writeSlugs: string[]
  upstreamSlugs: string[]
  rateLimitPerMin: number | null
  quotaPerDay: number | null
}

export interface Denied { status: number; error: string; retryAfterSec?: number }

// Token do consumidor: querystring (links compartilháveis) ou header (padrão).
export function readToken(req: Request): string {
  return String(req.query.token ?? req.headers['x-api-token'] ?? '')
}

export async function authenticateConsumer(token: string): Promise<Consumer | Denied> {
  if (!token) return { status: 401, error: 'Token ausente (?token=… ou header X-Api-Token).' }
  const row = (await db.query(
    `select c.*, t.slug as tenant_slug from api_credentials c
      join tenants t on t.id = c.tenant_id where c.token_hash = $1`,
    [hashToken(token)],
  )).rows[0]
  if (!row || row.revoked) return { status: 401, error: 'Token inválido ou revogado.' }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { status: 401, error: 'Token expirado.' }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    tenantId: String(row.tenant_id),
    tenantSlug: String(row.tenant_slug),
    datasetSlugs: (row.dataset_slugs as string[]) ?? [],
    writeSlugs: (row.write_slugs as string[]) ?? [],
    upstreamSlugs: (row.upstream_slugs as string[]) ?? [],
    rateLimitPerMin: row.rate_limit_per_min ?? null,
    quotaPerDay: row.quota_per_day ?? null,
  }
}

// ── Rate limit: janela deslizante de 60s, em memória ─────────────────────
// Guardamos os instantes das chamadas recentes por credencial. Um Map cresceria
// sem limite com tokens rotativos, então há uma varredura periódica.
const hits = new Map<string, number[]>()
const WINDOW_MS = 60_000

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [id, times] of hits) {
    const alive = times.filter((t) => t > cutoff)
    if (alive.length) hits.set(id, alive)
    else hits.delete(id)
  }
}, WINDOW_MS).unref() // não segura o processo vivo no shutdown

export function checkRateLimit(consumer: Consumer): Denied | null {
  const limit = consumer.rateLimitPerMin
  if (!limit || limit <= 0) return null // sem limite configurado

  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const times = (hits.get(consumer.id) ?? []).filter((t) => t > cutoff)

  if (times.length >= limit) {
    // Quando o pedido mais antigo da janela sair, abre uma vaga.
    const retryAfterSec = Math.max(1, Math.ceil((times[0] + WINDOW_MS - now) / 1000))
    hits.set(consumer.id, times)
    return {
      status: 429,
      error: `Limite de ${limit} requisições por minuto atingido para este token. Tente novamente em ${retryAfterSec}s.`,
      retryAfterSec,
    }
  }
  times.push(now)
  hits.set(consumer.id, times)
  return null
}

// ── Quota diária: durável, uma única ida ao banco ────────────────────────
// Incrementa e devolve o novo total no mesmo statement. A chamada recusada
// também conta — é de propósito: sem isso, um cliente em laço bate no banco
// indefinidamente sem nunca "gastar" nada.
export async function consumeQuota(consumer: Consumer): Promise<Denied | null> {
  if (!isDbAvailable()) return null
  const used = Number((await db.query(
    `insert into api_usage_daily (credential_id, day, calls)
     values ($1, current_date, 1)
     on conflict (credential_id, day) do update set calls = api_usage_daily.calls + 1
     returning calls`,
    [consumer.id],
  )).rows[0]?.calls ?? 0)

  const limit = consumer.quotaPerDay
  if (limit && limit > 0 && used > limit) {
    return { status: 429, error: `Cota diária de ${limit} requisições esgotada para este token.` }
  }
  return null
}

// Porta única: autentica + aplica limites. Devolve o consumidor ou a recusa.
export async function admit(token: string): Promise<Consumer | Denied> {
  const consumer = await authenticateConsumer(token)
  if ('status' in consumer) return consumer
  const limited = checkRateLimit(consumer)
  if (limited) return limited
  const overQuota = await consumeQuota(consumer)
  if (overQuota) return overQuota
  return consumer
}

export const isDenied = (v: Consumer | Denied): v is Denied => 'status' in v

// Responde uma recusa já com os headers que um cliente bem-comportado usa.
export function sendDenied(res: Response, d: Denied): void {
  if (d.retryAfterSec) res.setHeader('Retry-After', String(d.retryAfterSec))
  res.status(d.status).json({ error: d.error })
}

// ── Telemetria ───────────────────────────────────────────────────────────
export interface CallRecord {
  checkType: 'public' | 'gateway'
  credentialId?: string | null
  consumerName?: string | null
  requestId: string
  method: string
  endpoint: string
  status: number
  durationMs: number
  upstreamSlug?: string | null
  upstreamMs?: number | null
  datasetSlug?: string | null
  rows?: number | null
  bytes?: number | null
  error?: string | null
  ip?: string | null
}

// Best-effort: telemetria nunca pode derrubar nem atrasar a resposta.
// `connection_id` segue recebendo o NOME do consumidor só para não quebrar os
// painéis que já leem essa coluna; a análise nova usa credential_id.
export function recordCall(c: CallRecord): void {
  if (!isDbAvailable()) return
  void db.query(
    `insert into api_call_metrics
       (dataset_slug, connection_id, endpoint, status, ok, duration_ms, rows, bytes, error,
        check_type, credential_id, request_id, method, upstream_slug, upstream_ms, consumer_ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      c.datasetSlug ?? null, c.consumerName ?? null, c.endpoint, c.status, c.status < 400,
      c.durationMs, c.rows ?? null, c.bytes ?? null, c.error ?? null,
      c.checkType, c.credentialId ?? null, c.requestId, c.method,
      c.upstreamSlug ?? null, c.upstreamMs ?? null, c.ip ?? null,
    ],
  ).catch(() => { /* métrica é best-effort */ })
}

// Id de correlação: reaproveita o do cliente quando vier, senão gera. Volta na
// resposta para o consumidor conseguir citar a chamada ao abrir um chamado.
export function requestIdOf(req: Request): string {
  const incoming = req.headers['x-request-id']
  const v = Array.isArray(incoming) ? incoming[0] : incoming
  return (v && /^[\w.:-]{1,120}$/.test(v)) ? v : randomUUID()
}
