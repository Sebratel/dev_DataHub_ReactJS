// Cliente da Files API do Databricks: autenticação, envio e retentativas.
//
// Sem SDK, de propósito: o `databricks-sdk` é Python e este hub é Node. O que a
// integração usa da API são três chamadas, e o `fetch` nativo do Node 22 dá
// conta delas sem trazer dependência nova.
import { config } from '../../core/config.js'

const BASE_BACKOFF_MS = 1_000

export class DatabricksError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message)
    this.name = 'DatabricksError'
  }
}

/**
 * 429 e 5xx são do servidor ou da estrada: repetir faz sentido. 400, 401, 403 e
 * 404 são do nosso lado — credencial errada, permissão faltando, volume que não
 * existe. Repetir isso 5 vezes só atrasa o alerta e enche o log de ruído: o
 * estado que causou o erro não muda sozinho em 16 segundos.
 */
export function deveRepetir(status: number | null): boolean {
  if (status === null) return true // falha de rede/DNS/timeout
  if (status === 429) return true
  return status >= 500 && status <= 599
}

// ── Credencial ────────────────────────────────────────────────────────────
// O token OAuth é reaproveitado até perto de expirar: pedir um por envio
// multiplicaria chamadas sem necessidade (13 ciclos × N conjuntos por dia).
let tokenCache: { value: string; expiraEm: number } | null = null

/** Só para os testes — garante que cada caso comece sem token em cache. */
export function limparTokenCache(): void {
  tokenCache = null
}

async function obterToken(): Promise<string> {
  const { token, clientId, clientSecret, host } = config.databricks
  if (token) return token // PAT: caminho do piloto
  if (!clientId || !clientSecret) {
    throw new DatabricksError(
      'Databricks sem credencial: defina DATABRICKS_TOKEN ou DATABRICKS_CLIENT_ID/SECRET.',
      null, false,
    )
  }
  if (tokenCache && Date.now() < tokenCache.expiraEm) return tokenCache.value

  const basica = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const resp = await fetch(`https://${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basica}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    // O corpo de um erro de OIDC não traz o segredo, mas pode trazer o
    // client_id; fica de fora por via das dúvidas.
    throw new DatabricksError(
      `Falha ao obter token OAuth (HTTP ${resp.status}).`, resp.status, deveRepetir(resp.status),
    )
  }
  const dados = (await resp.json()) as { access_token?: string; expires_in?: number }
  if (!dados.access_token) {
    throw new DatabricksError('Resposta de token sem access_token.', resp.status, false)
  }
  // Renova 60 s antes de expirar: evita a corrida de usar um token que vence
  // entre o cabeçalho ser montado e a requisição chegar.
  const vidaMs = Math.max(60, (dados.expires_in ?? 3600) - 60) * 1000
  tokenCache = { value: dados.access_token, expiraEm: Date.now() + vidaMs }
  return tokenCache.value
}

function exigeHost(): string {
  const { host } = config.databricks
  if (!host) throw new DatabricksError('DATABRICKS_HOST não definido.', null, false)
  return host
}

/** Cada segmento do caminho vai codificado; a barra entre eles, não. */
function encodePath(caminho: string): string {
  return caminho.split('/').map((s) => encodeURIComponent(s)).join('/')
}

async function chamar(
  url: string, init: RequestInit & { okStatus?: number[] },
): Promise<Response> {
  const token = await obterToken()
  const { okStatus = [200, 204], ...rest } = init
  let resp: Response
  try {
    resp = await fetch(url, {
      ...rest,
      headers: { ...(rest.headers ?? {}), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.databricks.uploadTimeoutMs),
    })
  } catch (e) {
    // Rede, DNS, TLS ou timeout: sem status, e sempre vale repetir.
    throw new DatabricksError(`Falha de rede: ${(e as Error).message}`, null, true)
  }
  if (!okStatus.includes(resp.status)) {
    // O corpo pode conter a mensagem útil da API ("volume não existe"), mas
    // também pode ser HTML de proxy. Trunca para não inchar o log.
    const corpo = (await resp.text().catch(() => '')).slice(0, 300)
    throw new DatabricksError(
      `HTTP ${resp.status}${corpo ? `: ${corpo}` : ''}`, resp.status, deveRepetir(resp.status),
    )
  }
  return resp
}

export interface ResultadoEnvio { attempts: number }

/**
 * Repete só o que vale a pena repetir, com backoff 1 s, 2 s, 4 s, 8 s, 16 s.
 * Devolve quantas tentativas foram usadas — é o que o log de envio registra, e
 * é o número que denuncia uma instabilidade que ainda não virou falha.
 */
export async function comRetentativa<T>(
  acao: () => Promise<T>,
): Promise<{ valor: T; attempts: number }> {
  const maxTentativas = config.databricks.maxRetries + 1
  let ultimo: DatabricksError | null = null
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      return { valor: await acao(), attempts: tentativa }
    } catch (e) {
      const erro = e instanceof DatabricksError
        ? e
        : new DatabricksError((e as Error).message, null, false)
      ultimo = erro
      if (!erro.retryable || tentativa === maxTentativas) break
      const espera = BASE_BACKOFF_MS * 2 ** (tentativa - 1)
      await new Promise((r) => setTimeout(r, espera))
    }
  }
  throw ultimo ?? new DatabricksError('Falha desconhecida no envio.', null, false)
}

/** Idempotente: diretório que já existe responde ok. */
export async function criarDiretorio(caminhoVolume: string): Promise<void> {
  const host = exigeHost()
  await comRetentativa(() => chamar(
    `https://${host}/api/2.0/fs/directories${encodePath(caminhoVolume)}`,
    { method: 'PUT', okStatus: [200, 204, 409] },
  ))
}

export async function enviarArquivo(
  caminhoVolume: string, conteudo: Buffer, contentType = 'application/octet-stream',
): Promise<ResultadoEnvio> {
  const host = exigeHost()
  const { attempts } = await comRetentativa(() => chamar(
    `https://${host}/api/2.0/fs/files${encodePath(caminhoVolume)}?overwrite=true`,
    {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(conteudo),
    },
  ))
  return { attempts }
}

/** Conferência de setup: o volume existe e a credencial o enxerga? */
export async function conferirVolume(nomeCompleto: string): Promise<unknown> {
  const host = exigeHost()
  const { valor } = await comRetentativa(() => chamar(
    `https://${host}/api/2.1/unity-catalog/volumes/${encodeURIComponent(nomeCompleto)}`,
    { method: 'GET', okStatus: [200] },
  ))
  return valor.json()
}
