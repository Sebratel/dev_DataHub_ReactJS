// ─────────────────────────────────────────────────────────────────────────
// AIProvider — camada desacoplada de LLM (docs §12). O resto do sistema só
// conhece esta interface; trocar de provedor é implementar outra classe e
// mudar AI_PROVIDER no .env. Nunca acoplar a IA ao restante do sistema.
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
  chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn>
  toolResultMessage(results: { toolCallId: string; content: string; isError?: boolean }[]): AiMessage
  isConfigured(): boolean
}

// ── Anthropic (default) ───────────────────────────────────────
class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  private client: Anthropic | null = null
  private model = process.env.AI_MODEL || 'claude-opus-4-8'

  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic()
    return this.client
  }

  async chat(system: string, messages: AiMessage[], tools: AiToolDef[]): Promise<AiTurn> {
    const response = await this.getClient().messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
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

// Factory — outros provedores (OpenAI, Google, Ollama) entram aqui na v1.0.
export function getProvider(): AIProvider {
  const which = (process.env.AI_PROVIDER || 'anthropic').toLowerCase()
  if (which === 'anthropic') return new AnthropicProvider()
  throw new Error(`AI_PROVIDER desconhecido: ${which} (suportado no MVP: anthropic)`)
}
