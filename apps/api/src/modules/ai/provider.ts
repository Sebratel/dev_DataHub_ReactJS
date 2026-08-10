// ─────────────────────────────────────────────────────────────────────────
// AIProvider — camada desacoplada de LLM (docs §12). O resto do sistema só
// conhece esta interface; trocar de provedor não toca em mais nada.
//
// Três dialetos, uma interface:
//   • anthropic — SDK oficial (@anthropic-ai/sdk)
//   • openai    — REST /chat/completions. Cobre também Azure OpenAI, Groq,
//                 OpenRouter, Together e servidores locais compatíveis: muda só
//                 a base_url. É por isso que o campo se chama "kind".
//   • gemini    — REST generateContent do Google
//
// OpenAI e Gemini vão por HTTP direto, sem SDK: são duas dependências a menos
// na imagem, e o contrato que usamos aqui (mensagens + tool use) é pequeno e
// estável nos dois. O Anthropic mantém o SDK porque já estava e porque é o
// caminho recomendado.
//
// A DIFERENÇA QUE IMPORTA está no formato de tool use — cada um tem o seu, e é
// justamente o que esta camada normaliza. O `raw` de cada turno guarda o
// formato NATIVO do provedor, porque é ele que volta na próxima requisição.
// ─────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk'

export interface AiToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AiToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AiTurn {
  text: string
  toolCalls: AiToolCall[]
  raw: unknown // conteúdo bruto do turno (devolvido no próximo request)
}

export interface AiMessage {
  role: 'user' | 'assistant'
  content: unknown // string ou blocos brutos do provedor
}

export interface AIProvider {
  readonly name: string
  readonly model: string
  chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn>
  toolResultMessage(results: { toolCallId: string; content: string; isError?: boolean }[]): AiMessage
  isConfigured(): boolean
  /** Modelos que ESTA chave alcança — evita escolher no escuro e digitar errado. */
  listModels(): Promise<ModelOption[]>
}

export type ProviderKind = 'anthropic' | 'openai' | 'gemini'

export interface ProviderConfig {
  kind: ProviderKind
  model: string
  apiKey: string
  baseUrl?: string | null
  maxTokens?: number
  effort?: string | null
}

// Tempo limite das chamadas ao provedor. Sem isto, um provedor lento deixa a
// requisição do usuário pendurada até o timeout do navegador.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120_000

async function postJson(
  url: string, body: unknown, headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: abort.signal,
    })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) as Record<string, unknown> } catch { /* corpo não-JSON */ }
    if (!res.ok) {
      // A mensagem do provedor é mais útil que "HTTP 401" — extrai onde estiver.
      const err = json.error as { message?: string } | string | undefined
      const detail = typeof err === 'string' ? err : err?.message
      throw new Error(detail || text.slice(0, 300) || `HTTP ${res.status}`)
    }
    return json
  } catch (e) {
    if (abort.signal.aborted) {
      throw new Error(`O provedor de IA não respondeu em ${Math.round(TIMEOUT_MS / 1000)}s.`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(
  url: string, headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const res = await fetch(url, { headers, signal: abort.signal })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) as Record<string, unknown> } catch { /* corpo não-JSON */ }
    if (!res.ok) {
      const err = json.error as { message?: string } | string | undefined
      const detail = typeof err === 'string' ? err : err?.message
      throw new Error(detail || text.slice(0, 300) || `HTTP ${res.status}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

// Modelo disponível para a chave cadastrada.
export interface ModelOption { id: string; label: string }

// ── Anthropic ────────────────────────────────────────────────────────────
class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  readonly model: string
  private client: Anthropic | null = null
  private cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.model = cfg.model
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.cfg.apiKey,
        ...(this.cfg.baseUrl ? { baseURL: this.cfg.baseUrl } : {}),
      })
    }
    return this.client
  }

  async chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn> {
    const response = await this.getClient().messages.create({
      model: this.model,
      max_tokens: this.cfg.maxTokens ?? 16_000,
      // Pensamento adaptativo: o modelo decide quanto raciocinar por pergunta.
      thinking: { type: 'adaptive' },
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } as never } : {}),
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content as never })),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as never,
      })),
    })

    if (response.stop_reason === 'refusal') {
      return { text: 'Não consegui atender a esse pedido. Reformule, por favor.', toolCalls: [], raw: response.content }
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text).join('\n')
    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))
    return { text, toolCalls, raw: response.content }
  }

  async listModels(): Promise<ModelOption[]> {
    const base = (this.cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
    const json = await getJson(`${base}/v1/models?limit=100`, {
      'x-api-key': this.cfg.apiKey,
      'anthropic-version': '2023-06-01',
    })
    const data = (json.data as { id?: string; display_name?: string }[] | undefined) ?? []
    return data
      .filter((m) => m.id)
      .map((m) => ({ id: String(m.id), label: m.display_name || String(m.id) }))
  }

  toolResultMessage(results: { toolCallId: string; content: string; isError?: boolean }[]): AiMessage {
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    }
  }
}

// ── OpenAI e compatíveis ─────────────────────────────────────────────────
// Diferença estrutural: o resultado de ferramenta é uma MENSAGEM própria com
// role 'tool' (no Anthropic é um bloco dentro de uma mensagem de usuário).
// Por isso `toolResultMessage` devolve um array de mensagens embrulhado — o
// aiRouter empurra como um item só e o adaptador desembrulha na hora de enviar.
interface OpenAiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

class OpenAiProvider implements AIProvider {
  readonly name = 'openai'
  readonly model: string
  private cfg: ProviderConfig

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.model = cfg.model
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey
  }

  private url(): string {
    const base = (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  // Achata o histórico da nossa forma para a do OpenAI. Uma mensagem nossa
  // pode carregar VÁRIOS resultados de ferramenta; lá cada um é uma mensagem.
  private toOpenAiMessages(system: string, messages: AiMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [{ role: 'system', content: system }]
    for (const m of messages) {
      if (Array.isArray(m.content) && m.content.length && (m.content[0] as { role?: string }).role === 'tool') {
        out.push(...(m.content as Record<string, unknown>[]))
        continue
      }
      out.push(m.content && typeof m.content === 'object'
        ? m.content as Record<string, unknown>
        : { role: m.role, content: String(m.content ?? '') })
    }
    return out
  }

  async chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn> {
    const body = {
      model: this.model,
      max_completion_tokens: this.cfg.maxTokens ?? 16_000,
      messages: this.toOpenAiMessages(system, messages),
      ...(tools.length ? {
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      } : {}),
    }
    const json = await postJson(this.url(), body, { authorization: `Bearer ${this.cfg.apiKey}` })
    const choice = (json.choices as { message?: Record<string, unknown> }[] | undefined)?.[0]
    const msg = choice?.message ?? {}
    const rawCalls = (msg.tool_calls as OpenAiToolCall[] | undefined) ?? []

    const toolCalls: AiToolCall[] = rawCalls.map((c) => {
      let input: Record<string, unknown> = {}
      // `arguments` é uma STRING de JSON — nunca um objeto. Um modelo pode
      // devolver JSON inválido aqui; falhar a conversa inteira por isso seria
      // desproporcional, então a ferramenta recebe entrada vazia e reclama.
      try { input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown> } catch { /* entrada inválida */ }
      return { id: c.id, name: c.function.name, input }
    })

    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      raw: { role: 'assistant', content: msg.content ?? null, ...(rawCalls.length ? { tool_calls: rawCalls } : {}) },
    }
  }

  async listModels(): Promise<ModelOption[]> {
    const base = (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const json = await getJson(`${base}/models`, { authorization: `Bearer ${this.cfg.apiKey}` })
    const data = (json.data as { id?: string }[] | undefined) ?? []
    // A lista traz embeddings, TTS, moderação… nada disso conversa. Filtra o
    // que serve para chat; se o filtro zerar (provedor compatível com nomes
    // próprios), devolve tudo em vez de uma lista vazia e inútil.
    const chatty = data.filter((m) => m.id && /gpt|^o\d|chat|llama|mistral|qwen|claude|gemini|deepseek/i.test(m.id))
    const use = chatty.length ? chatty : data.filter((m) => m.id)
    return use.map((m) => ({ id: String(m.id), label: String(m.id) })).sort((a, b) => a.id.localeCompare(b.id))
  }

  toolResultMessage(results: { toolCallId: string; content: string; isError?: boolean }[]): AiMessage {
    return {
      role: 'user',
      content: results.map((r) => ({
        role: 'tool',
        tool_call_id: r.toolCallId,
        content: r.isError ? `ERRO: ${r.content}` : r.content,
      })),
    }
  }
}

// ── Google Gemini ────────────────────────────────────────────────────────
// Diferenças estruturais: o papel do assistente chama-se 'model'; o system
// prompt vai num campo separado (systemInstruction); e o resultado de
// ferramenta é um functionResponse dentro de uma mensagem de usuário.
interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

class GeminiProvider implements AIProvider {
  readonly name = 'gemini'
  readonly model: string
  private cfg: ProviderConfig
  // O Gemini casa resultado com chamada pelo NOME da função, não por id. Como
  // a nossa interface fala em id, guardamos o mapa do último turno.
  private callNames = new Map<string, string>()

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg
    this.model = cfg.model
  }

  isConfigured(): boolean {
    return !!this.cfg.apiKey
  }

  private url(): string {
    const base = (this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
    return `${base}/models/${encodeURIComponent(this.model)}:generateContent`
  }

  private toContents(messages: AiMessage[]): Record<string, unknown>[] {
    return messages.map((m) => {
      if (m.content && typeof m.content === 'object' && 'parts' in (m.content as object)) {
        return m.content as Record<string, unknown>
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content ?? '') }],
      }
    })
  }

  async chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn> {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: this.toContents(messages),
      generationConfig: { maxOutputTokens: this.cfg.maxTokens ?? 16_000 },
      ...(tools.length ? {
        tools: [{
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }],
      } : {}),
    }
    const json = await postJson(this.url(), body, { 'x-goog-api-key': this.cfg.apiKey })

    const candidate = (json.candidates as { content?: { parts?: GeminiPart[] } }[] | undefined)?.[0]
    const parts = candidate?.content?.parts ?? []

    const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n')
    const toolCalls: AiToolCall[] = []
    this.callNames.clear()
    for (const [i, p] of parts.entries()) {
      if (!p.functionCall) continue
      // Id sintético: a nossa interface exige um, o Gemini não devolve.
      const id = `${p.functionCall.name}-${i}`
      this.callNames.set(id, p.functionCall.name)
      toolCalls.push({ id, name: p.functionCall.name, input: p.functionCall.args ?? {} })
    }

    return { text, toolCalls, raw: { role: 'model', parts } }
  }

  async listModels(): Promise<ModelOption[]> {
    const base = (this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
    const json = await getJson(`${base}/models?pageSize=200`, { 'x-goog-api-key': this.cfg.apiKey })
    const models = (json.models as {
      name?: string; displayName?: string; supportedGenerationMethods?: string[]
    }[] | undefined) ?? []
    return models
      // Só os que respondem generateContent — a lista traz embeddings e
      // modelos de imagem, que quebrariam na primeira pergunta.
      .filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes('generateContent'))
      // A API devolve "models/gemini-2.5-pro"; o campo do formulário quer o id.
      .map((m) => {
        const id = String(m.name).replace(/^models\//, '')
        return { id, label: m.displayName || id }
      })
  }

  toolResultMessage(results: { toolCallId: string; content: string; isError?: boolean }[]): AiMessage {
    return {
      role: 'user',
      content: {
        role: 'user',
        parts: results.map((r) => ({
          functionResponse: {
            name: this.callNames.get(r.toolCallId) ?? r.toolCallId,
            response: r.isError ? { error: r.content } : { result: r.content },
          },
        })),
      },
    }
  }
}

export function buildProvider(cfg: ProviderConfig): AIProvider {
  if (cfg.kind === 'anthropic') return new AnthropicProvider(cfg)
  if (cfg.kind === 'openai') return new OpenAiProvider(cfg)
  if (cfg.kind === 'gemini') return new GeminiProvider(cfg)
  throw new Error(`Provedor de IA desconhecido: ${cfg.kind}`)
}

// Provedor vindo do .env — usado só quando não há nenhum cadastrado na tela.
// Mantido para não quebrar instalações existentes durante a transição.
export function envProviderConfig(): ProviderConfig | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  return {
    kind: (process.env.AI_PROVIDER as ProviderKind) || 'anthropic',
    model: process.env.AI_MODEL || 'claude-opus-5',
    apiKey: key,
    maxTokens: 16_000,
  }
}
