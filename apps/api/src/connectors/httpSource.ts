// ─────────────────────────────────────────────────────────────────────────
// Fonte HTTP (API GET) — busca dados de uma API paginada e entrega os registros
// em LOTES (uma página por vez), para o mesmo pipeline JSONL→Parquet do ingest.
// Auth por header (token/Bearer/x-api-key). Paginação: page, offset ou nenhuma.
// Puro (sem DB/estado global) → testável isoladamente.
// ─────────────────────────────────────────────────────────────────────────

export interface HttpAuth {
  header?: string // ex.: 'Authorization' ou 'x-api-key'
  scheme?: string // prefixo do valor, ex.: 'Bearer'; vazio = valor cru
  token?: string  // segredo (já descriptografado)
}

export interface HttpPagination {
  style: 'none' | 'page' | 'offset' | 'cursor'
  pageParam?: string  // 'page' (page) | 'offset' (offset) | param do cursor
  sizeParam?: string  // 'per_page' | 'limit'
  size?: number       // itens por página
  start?: number      // 1 (page) ou 0 (offset) por padrão
  // cursor:
  cursorPath?: string // caminho (dot) no corpo até o PRÓXIMO cursor (ex.: 'meta.next')
  linkHeader?: boolean // usar o header Link (rel="next") em vez do corpo
}

export interface HttpEndpoint {
  baseUrl: string
  path: string
  query?: Record<string, string>
  recordsPath?: string // caminho (dot) até o array no JSON; vazio = a raiz é o array
  auth?: HttpAuth
  pagination?: HttpPagination
}

export interface FetchOpts {
  pauseMs?: number
  maxPages?: number
  signal?: AbortSignal
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Caminho (dot) num objeto: 'meta.next' → body.meta.next.
function getByPath(body: unknown, path?: string): unknown {
  let node: unknown = body
  if (path) for (const seg of path.split('.').filter(Boolean)) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined
  }
  return node
}

// Extrai o array de registros do corpo pelo recordsPath (ex.: 'data.items').
// Sem path e raiz-array → usa a raiz. Objeto único → embrulha em [obj].
export function extractRecords(body: unknown, path?: string): Record<string, unknown>[] {
  const node = getByPath(body, path)
  if (Array.isArray(node)) return node as Record<string, unknown>[]
  if (node && typeof node === 'object') return [node as Record<string, unknown>]
  return []
}

// Extrai a URL de rel="next" de um header Link (RFC 5988).
function parseNextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i)
    if (m) return m[1]
  }
  return null
}

function buildUrl(ep: HttpEndpoint, cursor: string | number | null): string {
  const base = ep.baseUrl.endsWith('/') ? ep.baseUrl : ep.baseUrl + '/'
  const u = new URL(String(ep.path).replace(/^\//, ''), base)
  for (const [k, v] of Object.entries(ep.query ?? {})) u.searchParams.set(k, v)
  const pg = ep.pagination
  if (pg && pg.style !== 'none') {
    if (cursor != null) {
      const param = pg.pageParam ?? (pg.style === 'offset' ? 'offset' : pg.style === 'cursor' ? 'cursor' : 'page')
      u.searchParams.set(param, String(cursor))
    }
    if (pg.sizeParam && pg.size) u.searchParams.set(pg.sizeParam, String(pg.size))
  }
  return u.toString()
}

function authHeaders(auth?: HttpAuth): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' }
  if (auth?.header && auth.token) {
    h[auth.header] = auth.scheme ? `${auth.scheme} ${auth.token}` : auth.token
  }
  return h
}

// Testa alcance de uma API (GET na baseUrl). "ok" = respondeu algo HTTP (mesmo
// 4xx = alcançável); erro só em falha de rede/timeout/DNS.
export async function testHttp(
  baseUrl: string, auth?: HttpAuth, timeoutMs = 10_000,
): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const started = Date.now()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(baseUrl, { headers: authHeaders(auth), signal: ctrl.signal })
    return { ok: true, status: res.status, latencyMs: Date.now() - started }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: (e as Error).message }
  } finally {
    clearTimeout(t)
  }
}

// Uma "medida" por página, para observabilidade (Fase 2).
export interface PageMetric { url: string; status: number; ms: number; rows: number; bytes: number }

// Gera lotes de registros, paginando até esvaziar (ou última página parcial).
// onMetric recebe a medição de cada chamada (latência/status/bytes).
export async function* fetchHttpPages(
  ep: HttpEndpoint,
  opts: FetchOpts = {},
  onMetric?: (m: PageMetric) => void,
): AsyncGenerator<Record<string, unknown>[]> {
  const headers = authHeaders(ep.auth)
  const pg = ep.pagination ?? { style: 'none' as const }
  const size = pg.size
  // page/offset avançam um número; cursor começa nulo (1ª página sem token).
  let cursor: string | number | null = pg.style === 'cursor' ? null : (pg.start ?? (pg.style === 'offset' ? 0 : 1))
  let nextUrl: string | null = null // Link header pode devolver a URL completa

  for (let i = 0; ; i++) {
    const url = nextUrl ?? buildUrl(ep, cursor)
    const started = Date.now()
    const ctrl = opts.timeoutMs ? new AbortController() : null
    const timer = ctrl && opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null
    // Encadeia o signal externo (cancelamento) com o de timeout.
    if (opts.signal) opts.signal.addEventListener('abort', () => ctrl?.abort(), { once: true })
    let res: Response
    try {
      res = await fetch(url, { headers, signal: ctrl?.signal ?? opts.signal })
    } finally {
      if (timer) clearTimeout(timer)
    }
    const text = await res.text()
    const ms = Date.now() - started
    if (!res.ok) {
      onMetric?.({ url, status: res.status, ms, rows: 0, bytes: text.length })
      throw new Error(`API respondeu HTTP ${res.status} em ${url}: ${text.slice(0, 200)}`)
    }
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new Error(`Resposta não-JSON de ${url}: ${text.slice(0, 120)}`) }
    const records = extractRecords(body, ep.recordsPath)
    onMetric?.({ url, status: res.status, ms, rows: records.length, bytes: text.length })

    if (records.length) yield records
    if (pg.style === 'none') return
    if (pg.style === 'cursor') {
      if (pg.linkHeader) {
        nextUrl = parseNextLink(res.headers.get('link'))
        if (!nextUrl) return
      } else {
        const next = getByPath(body, pg.cursorPath)
        if (next == null || next === '') return
        cursor = typeof next === 'number' ? next : String(next)
        nextUrl = null
      }
    } else {
      // page/offset: última página = veio menos que o tamanho pedido (ou nada).
      if (!records.length || (size != null && records.length < size)) return
      cursor = (cursor as number) + (pg.style === 'offset' ? (size ?? records.length) : 1)
    }
    // Guarda anti-loop: se a próxima requisição seria idêntica à atual (cursor
    // que não avança), para em vez de repetir para sempre.
    if ((nextUrl ?? buildUrl(ep, cursor)) === url) return
    if (opts.maxPages && i + 1 >= opts.maxPages) return
    if (opts.pauseMs) await sleep(opts.pauseMs)
  }
}

// Busca uma amostra (1ª página) para inferir os campos ao publicar o dataset.
export async function sampleHttp(ep: HttpEndpoint, opts: FetchOpts = {}): Promise<Record<string, unknown>[]> {
  for await (const batch of fetchHttpPages(ep, { ...opts, maxPages: 1 })) return batch.slice(0, 50)
  return []
}

// Infere {key, type} a partir de registros de amostra. Conservador: strings
// ficam como 'text' (evita os problemas de data/duração que já vimos).
export function inferFields(records: Record<string, unknown>[]): { key: string; type: 'number' | 'bool' | 'json' | 'text' }[] {
  const types = new Map<string, Set<string>>()
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      const t = v === null || v === undefined ? 'null'
        : typeof v === 'number' ? 'number'
        : typeof v === 'boolean' ? 'bool'
        : typeof v === 'object' ? 'json'
        : 'text'
      if (!types.has(k)) types.set(k, new Set())
      types.get(k)!.add(t)
    }
  }
  return [...types.entries()].map(([key, set]) => {
    set.delete('null')
    const only = set.size === 1 ? [...set][0] : null
    const type = only === 'number' ? 'number' : only === 'bool' ? 'bool' : only === 'json' ? 'json' : 'text'
    return { key, type }
  })
}
