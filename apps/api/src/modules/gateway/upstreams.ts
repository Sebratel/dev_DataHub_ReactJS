// ─────────────────────────────────────────────────────────────────────────
// Registro de upstreams — as APIs internas que JÁ EXISTEM e passam a ser
// servidas atrás do gateway.
//
// O plano de dados (proxy.ts) não pode ir ao banco a cada requisição, então o
// registro fica em cache de processo e é recarregado a cada mutação — mesmo
// padrão do connectors/store.ts, que já é validado em produção aqui.
//
// O segredo do upstream é cifrado em repouso e só é decifrado no momento de
// montar a requisição. Ele NUNCA sai numa resposta da API de administração.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { encryptSecret, decryptSecret } from '../../core/crypto.js'

export type AuthMode = 'none' | 'bearer' | 'header' | 'basic'
export type UpstreamStatus = 'pending' | 'active' | 'rejected'

export interface Upstream {
  id: string
  tenantSlug: string
  slug: string
  name: string
  description: string
  baseUrl: string
  authMode: AuthMode
  authHeader: string | null
  methods: string[]
  timeoutMs: number
  stripPrefix: boolean
  forwardHeaders: string[]
  status: UpstreamStatus
  enabled: boolean
  ownerEmail: string
  reviewedBy: string | null
  reviewedAt: string | null
  createdAt: string
  /** Só `true`/`false` — o valor jamais é exposto. */
  hasSecret: boolean
}

interface CacheEntry extends Upstream { authSecretEnc: string | null }

const cache = new Map<string, CacheEntry>() // `${tenantSlug}:${slug}`
const keyOf = (tenant: string, slug: string) => `${tenant}:${slug}`

function toEntry(r: Record<string, unknown>): CacheEntry {
  return {
    id: String(r.id),
    tenantSlug: String(r.tenant_slug),
    slug: String(r.slug),
    name: String(r.name),
    description: String(r.description ?? ''),
    baseUrl: String(r.base_url),
    authMode: (r.auth_mode as AuthMode) ?? 'none',
    authHeader: (r.auth_header as string | null) ?? null,
    methods: (r.methods as string[]) ?? ['GET'],
    timeoutMs: Number(r.timeout_ms ?? 15000),
    stripPrefix: r.strip_prefix !== false,
    forwardHeaders: (r.forward_headers as string[]) ?? [],
    status: (r.status as UpstreamStatus) ?? 'pending',
    enabled: r.enabled !== false,
    ownerEmail: String(r.owner_email),
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    authSecretEnc: (r.auth_secret_enc as string | null) ?? null,
    hasSecret: !!r.auth_secret_enc,
  }
}

const publicView = ({ authSecretEnc: _omit, ...rest }: CacheEntry): Upstream => rest

export async function reloadUpstreams(): Promise<void> {
  if (!isDbAvailable()) return
  const rows = (await db.query(
    `select u.*, t.slug as tenant_slug from gateway_upstreams u
      join tenants t on t.id = u.tenant_id`,
  )).rows
  cache.clear()
  for (const r of rows) {
    const e = toEntry(r)
    cache.set(keyOf(e.tenantSlug, e.slug), e)
  }
  console.log(`[gateway] ${cache.size} upstream(s) carregado(s).`)
}

// Resolução do caminho quente: só upstream APROVADO e habilitado responde.
export function resolveUpstream(tenantSlug: string, slug: string): CacheEntry | null {
  const e = cache.get(keyOf(tenantSlug, slug))
  if (!e || !e.enabled || e.status !== 'active') return null
  return e
}

// Header de autenticação do upstream, montado na hora. O consumidor nunca vê.
export function upstreamAuthHeader(e: CacheEntry): { name: string; value: string } | null {
  if (e.authMode === 'none' || !e.authSecretEnc) return null
  const secret = decryptSecret(e.authSecretEnc)
  if (e.authMode === 'bearer') return { name: 'authorization', value: `Bearer ${secret}` }
  if (e.authMode === 'basic') return { name: 'authorization', value: `Basic ${Buffer.from(secret).toString('base64')}` }
  if (e.authMode === 'header' && e.authHeader) return { name: e.authHeader.toLowerCase(), value: secret }
  return null
}

// ── Administração ────────────────────────────────────────────────────────
export interface UpstreamInput {
  slug: string
  name: string
  description?: string
  baseUrl: string
  authMode?: AuthMode
  authHeader?: string | null
  /** Ausente = mantém o segredo atual; string vazia = remove. */
  secret?: string
  methods?: string[]
  timeoutMs?: number
  stripPrefix?: boolean
  forwardHeaders?: string[]
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

export function validateInput(input: UpstreamInput): void {
  if (!SLUG_RE.test(input.slug ?? '')) {
    throw new Error('Identificador inválido: use minúsculas, números e hífen (3 a 50 caracteres).')
  }
  if (!input.name?.trim()) throw new Error('Informe um nome para o upstream.')

  let url: URL
  try { url = new URL(input.baseUrl) } catch { throw new Error('URL de destino inválida.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A URL de destino deve usar http ou https.')
  }
  for (const m of input.methods ?? ['GET']) {
    if (!METHODS.has(m)) throw new Error(`Método não suportado: "${m}".`)
  }
  if (input.timeoutMs != null && (input.timeoutMs < 500 || input.timeoutMs > 120_000)) {
    throw new Error('O tempo limite deve ficar entre 500 ms e 120 s.')
  }
  if (input.authMode === 'header' && !input.authHeader?.trim()) {
    throw new Error('Informe o nome do header quando a autenticação for por header.')
  }
}

export async function listUpstreams(tenantSlug: string): Promise<Upstream[]> {
  const rows = (await db.query(
    `select u.*, t.slug as tenant_slug from gateway_upstreams u
      join tenants t on t.id = u.tenant_id
      where t.slug = $1 order by u.created_at desc`,
    [tenantSlug],
  )).rows
  return rows.map((r) => publicView(toEntry(r)))
}

export async function createUpstream(
  tenantSlug: string, input: UpstreamInput, ownerEmail: string, autoApprove: boolean,
): Promise<Upstream> {
  validateInput(input)
  const row = (await db.query(
    `insert into gateway_upstreams
       (tenant_id, slug, name, description, base_url, auth_mode, auth_header, auth_secret_enc,
        methods, timeout_ms, strip_prefix, forward_headers, status, owner_email, reviewed_by, reviewed_at)
     select t.id, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       from tenants t where t.slug = $1
     returning *`,
    [
      tenantSlug, input.slug, input.name.trim(), input.description?.trim() ?? '', input.baseUrl,
      input.authMode ?? 'none', input.authHeader?.trim() || null,
      input.secret ? encryptSecret(input.secret) : null,
      input.methods ?? ['GET'], input.timeoutMs ?? 15_000,
      input.stripPrefix !== false, input.forwardHeaders ?? [],
      autoApprove ? 'active' : 'pending', ownerEmail,
      autoApprove ? ownerEmail : null, autoApprove ? new Date().toISOString() : null,
    ],
  )).rows[0]
  if (!row) throw new Error('Tenant não encontrado.')
  await reloadUpstreams()
  return publicView(toEntry({ ...row, tenant_slug: tenantSlug }))
}

export async function updateUpstream(
  tenantSlug: string, id: string, input: UpstreamInput,
): Promise<Upstream> {
  validateInput(input)
  // secret: undefined = mantém; '' = remove; string = troca.
  const secretSql = input.secret === undefined
    ? 'auth_secret_enc'
    : (input.secret === '' ? 'null' : '$9')
  const params: unknown[] = [
    id, tenantSlug, input.slug, input.name.trim(), input.description?.trim() ?? '',
    input.baseUrl, input.authMode ?? 'none', input.authHeader?.trim() || null,
  ]
  if (input.secret) params.push(encryptSecret(input.secret))
  const base = params.length
  params.push(input.methods ?? ['GET'], input.timeoutMs ?? 15_000,
    input.stripPrefix !== false, input.forwardHeaders ?? [])

  const row = (await db.query(
    `update gateway_upstreams u set
       slug = $3, name = $4, description = $5, base_url = $6,
       auth_mode = $7, auth_header = $8, auth_secret_enc = ${secretSql},
       methods = $${base + 1}, timeout_ms = $${base + 2},
       strip_prefix = $${base + 3}, forward_headers = $${base + 4},
       updated_at = now()
     from tenants t
     where u.id = $1 and u.tenant_id = t.id and t.slug = $2
     returning u.*`,
    params,
  )).rows[0]
  if (!row) throw new Error('Upstream não encontrado.')
  await reloadUpstreams()
  return publicView(toEntry({ ...row, tenant_slug: tenantSlug }))
}

export async function reviewUpstream(
  tenantSlug: string, id: string, status: 'active' | 'rejected', reviewer: string,
): Promise<Upstream> {
  const row = (await db.query(
    `update gateway_upstreams u
        set status = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now()
      from tenants t
      where u.id = $1 and u.tenant_id = t.id and t.slug = $2
      returning u.*`,
    [id, tenantSlug, status, reviewer],
  )).rows[0]
  if (!row) throw new Error('Upstream não encontrado.')
  await reloadUpstreams()
  return publicView(toEntry({ ...row, tenant_slug: tenantSlug }))
}

export async function setUpstreamEnabled(
  tenantSlug: string, id: string, enabled: boolean,
): Promise<void> {
  await db.query(
    `update gateway_upstreams u set enabled = $3, updated_at = now()
      from tenants t where u.id = $1 and u.tenant_id = t.id and t.slug = $2`,
    [id, tenantSlug, enabled],
  )
  await reloadUpstreams()
}

export async function deleteUpstream(tenantSlug: string, id: string): Promise<void> {
  await db.query(
    `delete from gateway_upstreams u using tenants t
      where u.id = $1 and u.tenant_id = t.id and t.slug = $2`,
    [id, tenantSlug],
  )
  await reloadUpstreams()
}
