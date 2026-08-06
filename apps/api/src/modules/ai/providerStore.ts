// Registro de provedores de IA: CRUD, cache de processo e teste de conexão.
//
// O provedor ativo é resolvido a cada chamada da IA, então precisa vir de
// memória — mesmo padrão do connectors/store.ts. A chave é decifrada só no
// momento de montar o cliente e nunca sai numa resposta da API.
import { db, isDbAvailable } from '../../db/pool.js'
import { encryptSecret, decryptSecret } from '../../core/crypto.js'
import { buildProvider, envProviderConfig, type AIProvider, type ProviderConfig, type ProviderKind } from './provider.js'

export interface AiProviderRow {
  id: string
  tenantSlug: string
  name: string
  kind: ProviderKind
  model: string
  baseUrl: string | null
  keyHint: string | null
  maxTokens: number
  effort: string | null
  enabled: boolean
  isDefault: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  lastTestMs: number | null
  ownerEmail: string
  createdAt: string
  /** A chave existe? O valor jamais é exposto. */
  hasKey: boolean
}

interface CacheEntry extends AiProviderRow { apiKeyEnc: string | null }

const cache = new Map<string, CacheEntry[]>() // tenantSlug → provedores

function toEntry(r: Record<string, unknown>): CacheEntry {
  return {
    id: String(r.id),
    tenantSlug: String(r.tenant_slug),
    name: String(r.name),
    kind: r.kind as ProviderKind,
    model: String(r.model),
    baseUrl: (r.base_url as string | null) ?? null,
    keyHint: (r.key_hint as string | null) ?? null,
    maxTokens: Number(r.max_tokens ?? 16_000),
    effort: (r.effort as string | null) ?? null,
    enabled: r.enabled !== false,
    isDefault: r.is_default === true,
    lastTestAt: r.last_test_at ? new Date(r.last_test_at as string).toISOString() : null,
    lastTestOk: (r.last_test_ok as boolean | null) ?? null,
    lastTestError: (r.last_test_error as string | null) ?? null,
    lastTestMs: r.last_test_ms === null || r.last_test_ms === undefined ? null : Number(r.last_test_ms),
    ownerEmail: String(r.owner_email),
    createdAt: new Date(r.created_at as string).toISOString(),
    apiKeyEnc: (r.api_key_enc as string | null) ?? null,
    hasKey: !!r.api_key_enc,
  }
}

const publicView = ({ apiKeyEnc: _omit, ...rest }: CacheEntry): AiProviderRow => rest

export async function reloadAiProviders(): Promise<void> {
  if (!isDbAvailable()) return
  const rows = (await db.query(
    `select p.*, t.slug as tenant_slug from ai_providers p join tenants t on t.id = p.tenant_id
      order by p.is_default desc, p.name`,
  )).rows
  cache.clear()
  for (const r of rows) {
    const e = toEntry(r)
    cache.set(e.tenantSlug, [...(cache.get(e.tenantSlug) ?? []), e])
  }
  const total = [...cache.values()].reduce((s, l) => s + l.length, 0)
  console.log(`[ai] ${total} provedor(es) de IA carregado(s).`)
}

export function listCached(tenantSlug: string): AiProviderRow[] {
  return (cache.get(tenantSlug) ?? []).map(publicView)
}

function toConfig(e: CacheEntry): ProviderConfig {
  return {
    kind: e.kind,
    model: e.model,
    apiKey: e.apiKeyEnc ? decryptSecret(e.apiKeyEnc) : '',
    baseUrl: e.baseUrl,
    maxTokens: e.maxTokens,
    effort: e.effort,
  }
}

/**
 * Provedor ativo do tenant. Ordem: o marcado como padrão → o primeiro
 * habilitado → o do .env (compatibilidade com instalações anteriores).
 * Devolve null quando não há nenhum — o chamador responde 503 com orientação.
 */
export function activeProvider(tenantSlug: string): AIProvider | null {
  const list = (cache.get(tenantSlug) ?? []).filter((p) => p.enabled && p.apiKeyEnc)
  const chosen = list.find((p) => p.isDefault) ?? list[0]
  if (chosen) {
    try {
      return buildProvider(toConfig(chosen))
    } catch (e) {
      console.warn(`[ai] provedor "${chosen.name}" inválido: ${(e as Error).message}`)
    }
  }
  const env = envProviderConfig()
  return env ? buildProvider(env) : null
}

// ── Administração ────────────────────────────────────────────────────────
export interface ProviderInput {
  name: string
  kind: ProviderKind
  model: string
  /** Ausente = mantém a chave atual; string vazia = remove. */
  apiKey?: string
  baseUrl?: string | null
  maxTokens?: number
  effort?: string | null
  enabled?: boolean
  isDefault?: boolean
}

const KINDS = new Set<ProviderKind>(['anthropic', 'openai', 'gemini'])

export function validateInput(input: ProviderInput): void {
  if (!input.name?.trim()) throw new Error('Dê um nome ao provedor (ex.: "Claude de produção").')
  if (!KINDS.has(input.kind)) throw new Error('Provedor inválido. Escolha Anthropic, OpenAI ou Gemini.')
  if (!input.model?.trim()) throw new Error('Informe o modelo.')
  if (input.baseUrl) {
    try {
      const u = new URL(input.baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad')
    } catch { throw new Error('URL base inválida (use http ou https).') }
  }
  if (input.maxTokens != null && (input.maxTokens < 256 || input.maxTokens > 128_000)) {
    throw new Error('O teto de tokens deve ficar entre 256 e 128.000.')
  }
}

const hintOf = (key: string) => (key.length > 4 ? key.slice(-4) : null)

// Só UM padrão por tenant (garantido também por índice parcial no banco).
async function clearOtherDefaults(tenantSlug: string, keepId: string | null): Promise<void> {
  await db.query(
    `update ai_providers p set is_default = false, updated_at = now()
       from tenants t
      where p.tenant_id = t.id and t.slug = $1 and p.is_default and ($2::uuid is null or p.id <> $2)`,
    [tenantSlug, keepId],
  )
}

export async function createProvider(
  tenantSlug: string, input: ProviderInput, ownerEmail: string,
): Promise<AiProviderRow> {
  validateInput(input)
  if (!input.apiKey?.trim()) throw new Error('Informe a chave de API do provedor.')

  // O primeiro provedor cadastrado vira o padrão sozinho — senão a IA
  // continuaria "não configurada" mesmo com um provedor válido na tela.
  const existing = (cache.get(tenantSlug) ?? []).length
  const makeDefault = input.isDefault === true || existing === 0
  if (makeDefault) await clearOtherDefaults(tenantSlug, null)

  const row = (await db.query(
    `insert into ai_providers
       (tenant_id, name, kind, model, api_key_enc, key_hint, base_url, max_tokens, effort,
        enabled, is_default, owner_email)
     select t.id, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 from tenants t where t.slug = $1
     returning *`,
    [tenantSlug, input.name.trim(), input.kind, input.model.trim(),
     encryptSecret(input.apiKey), hintOf(input.apiKey), input.baseUrl?.trim() || null,
     input.maxTokens ?? 16_000, input.effort || null,
     input.enabled !== false, makeDefault, ownerEmail],
  )).rows[0]
  if (!row) throw new Error('Tenant não encontrado.')
  await reloadAiProviders()
  return publicView(toEntry({ ...row, tenant_slug: tenantSlug }))
}

export async function updateProvider(
  tenantSlug: string, id: string, input: ProviderInput,
): Promise<AiProviderRow> {
  validateInput(input)
  if (input.isDefault) await clearOtherDefaults(tenantSlug, id)

  // apiKey: undefined mantém, '' remove, string troca.
  const keyChanges = input.apiKey !== undefined
  const row = (await db.query(
    `update ai_providers p set
       name = $3, kind = $4, model = $5,
       base_url = $6, max_tokens = $7, effort = $8,
       enabled = $9, is_default = $10,
       api_key_enc = case when $11 then $12 else p.api_key_enc end,
       key_hint    = case when $11 then $13 else p.key_hint end,
       updated_at = now()
     from tenants t
     where p.id = $1 and p.tenant_id = t.id and t.slug = $2
     returning p.*`,
    [id, tenantSlug, input.name.trim(), input.kind, input.model.trim(),
     input.baseUrl?.trim() || null, input.maxTokens ?? 16_000, input.effort || null,
     input.enabled !== false, input.isDefault === true,
     keyChanges, input.apiKey ? encryptSecret(input.apiKey) : null,
     input.apiKey ? hintOf(input.apiKey) : null],
  )).rows[0]
  if (!row) throw new Error('Provedor não encontrado.')
  await reloadAiProviders()
  return publicView(toEntry({ ...row, tenant_slug: tenantSlug }))
}

export async function deleteProvider(tenantSlug: string, id: string): Promise<void> {
  await db.query(
    `delete from ai_providers p using tenants t
      where p.id = $1 and p.tenant_id = t.id and t.slug = $2`,
    [id, tenantSlug],
  )
  await reloadAiProviders()
}

export async function setDefault(tenantSlug: string, id: string): Promise<void> {
  await clearOtherDefaults(tenantSlug, id)
  const r = await db.query(
    `update ai_providers p set is_default = true, enabled = true, updated_at = now()
       from tenants t where p.id = $1 and p.tenant_id = t.id and t.slug = $2`,
    [id, tenantSlug],
  )
  if (!r.rowCount) throw new Error('Provedor não encontrado.')
  await reloadAiProviders()
}

// ── Teste de conexão ─────────────────────────────────────────────────────
// Uma pergunta trivial, sem ferramentas. É o que separa "chave errada" de
// "modelo inexistente" ANTES de alguém descobrir no meio de uma conversa.
export interface TestResult { ok: boolean; ms: number; error?: string; sample?: string }

export async function testProvider(tenantSlug: string, id: string): Promise<TestResult> {
  const entry = (cache.get(tenantSlug) ?? []).find((p) => p.id === id)
  if (!entry) throw new Error('Provedor não encontrado.')
  if (!entry.apiKeyEnc) throw new Error('Este provedor não tem chave cadastrada.')

  const started = Date.now()
  let result: TestResult
  try {
    const provider = buildProvider(toConfig(entry))
    const turn = await provider.chat(
      'Você é um teste de conectividade. Responda apenas: OK',
      [{ role: 'user', content: 'Responda apenas OK.' }],
      [],
    )
    result = { ok: true, ms: Date.now() - started, sample: turn.text.slice(0, 120) }
  } catch (e) {
    result = { ok: false, ms: Date.now() - started, error: (e as Error).message }
  }

  await db.query(
    `update ai_providers set last_test_at = now(), last_test_ok = $2,
            last_test_error = $3, last_test_ms = $4, updated_at = now()
      where id = $1`,
    [id, result.ok, result.error ?? null, result.ms],
  )
  await reloadAiProviders()
  return result
}
