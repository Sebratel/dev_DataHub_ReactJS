// ─────────────────────────────────────────────────────────────────────────
// Plano de dados do gateway: proxy reverso para as APIs internas registradas.
//
//   GET|POST|… /api/public/v1/gw/<upstream>/<caminho…>
//
// O que acontece em cada requisição, nesta ordem:
//   1. token do consumidor → autentica, aplica rate limit e quota
//   2. escopo → o token precisa listar este upstream explicitamente
//   3. método na allowlist do upstream
//   4. caminho higienizado (nada de "..") e montado sobre a base_url
//   5. headers limpos: nenhuma credencial DO GATEWAY vaza para o upstream, e
//      nenhuma credencial DO UPSTREAM vaza para o consumidor
//   6. requisição com tempo limite (AbortController) e SEM seguir redirect
//   7. resposta transmitida em fluxo + telemetria com atribuição
//
// Notas de segurança:
//   • `redirect: 'manual'` é o que impede um upstream comprometido de usar um
//     302 para fazer o gateway buscar um host arbitrário (SSRF).
//   • O corpo chega como Buffer (express.raw) e é repassado sem interpretação —
//     o gateway não é dono do contrato do upstream.
// ─────────────────────────────────────────────────────────────────────────
import { Router, raw } from 'express'
import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { isDbAvailable } from '../../db/pool.js'
import { admit, isDenied, readToken, recordCall, requestIdOf, sendDenied } from './policy.js'
import { resolveUpstream, upstreamAuthHeader } from './upstreams.js'

// Corpo máximo aceito no proxy. Gateway não é canal de upload em massa.
const MAX_BODY = process.env.GATEWAY_MAX_BODY || '2mb'

// Headers que morrem no salto (RFC 9110) + os que carregam credencial do
// consumidor. Nunca são repassados ao upstream.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'accept-encoding',
  'authorization', 'x-api-token', 'cookie',
])

// Headers do cliente sempre repassados (o upstream precisa deles para responder
// direito). Qualquer outro só passa se o upstream o declarar em forward_headers.
const SAFE_FORWARD = new Set(['content-type', 'accept', 'accept-language', 'user-agent'])

// Headers da resposta do upstream que voltam ao consumidor. `content-encoding` e
// `content-length` ficam de fora de propósito: o fetch já descomprimiu o corpo,
// então repassá-los descreveria a resposta errada.
const SAFE_RESPONSE = new Set([
  'content-type', 'cache-control', 'etag', 'last-modified', 'expires',
  'content-disposition', 'content-language', 'retry-after', 'location',
])

// "/a/../../etc" e afins não podem escapar da base do upstream.
function safePath(raw: string): string | null {
  const path = raw.split('?')[0]
  if (path.includes('\\') || path.includes('\0')) return null
  const parts = decodeURIComponent(path).split('/')
  if (parts.some((p) => p === '..')) return null
  return path
}

function buildTargetUrl(baseUrl: string, rest: string, query: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const suffix = rest === '/' ? '' : rest
  const url = new URL(base + suffix)
  if (query) url.search = query
  return url
}

export const gatewayProxyRouter = Router()

gatewayProxyRouter.use(raw({ type: '*/*', limit: MAX_BODY }))

gatewayProxyRouter.use('/:slug', async (req: Request, res: Response) => {
  const started = Date.now()
  const requestId = requestIdOf(req)
  const slug = String(req.params.slug ?? '')
  const method = req.method.toUpperCase()
  const endpoint = `/gw/${slug}`
  res.setHeader('X-Request-Id', requestId)

  const ip = req.ip ?? null
  const fail = (status: number, error: string, consumer?: { id: string; name: string }) => {
    recordCall({
      checkType: 'gateway', requestId, method, endpoint, status,
      durationMs: Date.now() - started, upstreamSlug: slug, error, ip,
      credentialId: consumer?.id ?? null, consumerName: consumer?.name ?? null,
    })
    if (!res.headersSent) res.status(status).json({ error, requestId })
  }

  if (!isDbAvailable()) return fail(503, 'Serviço indisponível.')

  // 1. Consumidor + limites.
  const consumer = await admit(readToken(req))
  if (isDenied(consumer)) {
    recordCall({
      checkType: 'gateway', requestId, method, endpoint, status: consumer.status,
      durationMs: Date.now() - started, upstreamSlug: slug, error: consumer.error, ip,
    })
    return sendDenied(res, consumer)
  }
  const who = { id: consumer.id, name: consumer.name }

  // 2. Escopo: upstream é opt-in explícito no token (diferente de conjunto,
  //    onde uma lista vazia significa "todos").
  if (!consumer.upstreamSlugs.includes(slug)) {
    return fail(403, `Este token não tem acesso ao upstream "${slug}".`, who)
  }

  const up = resolveUpstream(consumer.tenantSlug, slug)
  if (!up) return fail(404, `Upstream "${slug}" não encontrado, desabilitado ou ainda não aprovado.`, who)

  // 3. Método permitido?
  if (!up.methods.includes(method)) {
    res.setHeader('Allow', up.methods.join(', '))
    return fail(405, `Método ${method} não permitido neste upstream. Permitidos: ${up.methods.join(', ')}.`, who)
  }

  // 4. Caminho. `router.use` já removeu o prefixo /gw/<slug>, então req.url é o
  //    resto. Com strip_prefix=false, o prefixo é reconstruído no destino.
  const rest = safePath(req.url || '/')
  if (rest === null) return fail(400, 'Caminho inválido.', who)
  const suffix = up.stripPrefix ? rest : `/${slug}${rest}`

  let target: URL
  try {
    target = buildTargetUrl(up.baseUrl, suffix, String(req.url).split('?')[1] ?? '')
  } catch {
    return fail(400, 'Não foi possível montar a URL de destino.', who)
  }

  // 5. Headers.
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || value === undefined) continue
    if (!SAFE_FORWARD.has(key) && !up.forwardHeaders.includes(key)) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
  }
  headers.set('x-request-id', requestId)
  headers.set('x-forwarded-for', ip ?? '')
  headers.set('x-forwarded-host', String(req.headers.host ?? ''))
  headers.set('x-gateway-consumer', consumer.name)
  try {
    const auth = upstreamAuthHeader(up)
    if (auth) headers.set(auth.name, auth.value)
  } catch (e) {
    return fail(500, `Credencial do upstream indisponível: ${(e as Error).message}`, who)
  }

  // 6. Requisição com tempo limite.
  const body = (method === 'GET' || method === 'HEAD') ? undefined
    : (Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), up.timeoutMs)
  const upstreamStarted = Date.now()

  let upstreamRes: globalThis.Response
  try {
    upstreamRes = await fetch(target, {
      method, headers, body,
      redirect: 'manual', // trava de SSRF — ver cabeçalho do arquivo
      signal: abort.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = abort.signal.aborted
    return fail(
      aborted ? 504 : 502,
      aborted
        ? `O serviço de destino não respondeu em ${Math.round(up.timeoutMs / 1000)}s.`
        : `Falha ao alcançar o serviço de destino: ${(e as Error).message}`,
      who,
    )
  }
  const upstreamMs = Date.now() - upstreamStarted
  clearTimeout(timer)

  // 7. Resposta.
  for (const [name, value] of upstreamRes.headers) {
    if (SAFE_RESPONSE.has(name.toLowerCase())) res.setHeader(name, value)
  }
  res.status(upstreamRes.status)

  const done = (bytes: number, error: string | null) => recordCall({
    checkType: 'gateway', requestId, method, endpoint,
    status: upstreamRes.status, durationMs: Date.now() - started,
    upstreamSlug: slug, upstreamMs, bytes, error, ip,
    credentialId: who.id, consumerName: who.name,
  })

  if (!upstreamRes.body) {
    res.end()
    return done(0, upstreamRes.ok ? null : `HTTP ${upstreamRes.status}`)
  }

  let bytes = 0
  const stream = Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('data', (chunk: Buffer) => { bytes += chunk.length })
  stream.on('error', (e) => {
    done(bytes, `fluxo interrompido: ${e.message}`)
    res.destroy(e)
  })
  stream.on('end', () => done(bytes, upstreamRes.ok ? null : `HTTP ${upstreamRes.status}`))
  stream.pipe(res)
})
