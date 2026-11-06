// ─────────────────────────────────────────────────────────────────────────
// Loop agêntico — o mesmo para o chat e para o construtor de widgets.
//
// A cada rodada o modelo responde em texto (fim) ou pede ferramentas; as
// ferramentas rodam e os resultados voltam para a próxima rodada.
//
// Duas coisas que este módulo garante e que antes faltavam:
//
//   • Ao esgotar as rodadas, o modelo ainda RESPONDE. Uma última chamada com
//     as ferramentas proibidas (toolChoice 'none') pede que ele diga o que
//     concluiu com o que já consultou e o que faltou. Antes, quem perguntava
//     recebia só "parei depois de 9 consultas" — e as consultas que tinham
//     dado certo eram jogadas fora.
//
//   • O rastro diz O QUE foi tentado, não só onde: os filtros de cada
//     consulta, quantas linhas voltaram e o motivo de cada erro. "Consultou
//     db-native" oito vezes não explica nada; "tag contains desbloqueio de
//     confianca → 0 linhas" explica tudo. Nunca guarda o resultado em si —
//     só o pedido e metadados (contagem, mensagem de erro).
// ─────────────────────────────────────────────────────────────────────────
import type { AIProvider, AiMessage, AiToolCall, AiToolDef } from './provider.js'
import type { ToolOutcome } from './tools.js'

export interface TraceStep {
  name: string
  /** Conjunto ou busca do passo. */
  alvo: string | null
  erro: boolean
  /** Os filtros/agrupamento tentados, ou o campo e a busca de valores. */
  detalhe?: string | null
  /** Linhas (ou valores, ou conjuntos) que voltaram. 0 é o sinal de chute errado. */
  linhas?: number | null
  /** Mensagem do erro, quando houve. */
  motivo?: string | null
}

export interface AgentResult {
  text: string
  trace: TraceStep[]
  limitReached: boolean
}

const curto = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function alvoDaTool(input: Record<string, unknown>): string | null {
  const v = input.dataset ?? input.slug ?? input.query
  return v == null ? null : curto(String(v), 60)
}

function valorCurto(v: unknown): string {
  if (Array.isArray(v)) return `[${v.slice(0, 4).map((x) => valorCurto(x)).join(', ')}${v.length > 4 ? ', …' : ''}]`
  if (v == null) return ''
  return typeof v === 'string' ? `"${curto(v, 40)}"` : curto(String(v), 40)
}

/** O pedido de cada ferramenta numa linha: o que a IA de fato tentou. */
export function detalheDaTool(name: string, input: Record<string, unknown>): string | null {
  if (name === 'list_field_values') {
    const partes = [`campo ${input.field ?? '?'}`]
    if (input.search) partes.push(`busca ${valorCurto(input.search)}`)
    if (input.separator) partes.push(`separador ${valorCurto(input.separator)}`)
    return partes.join(' · ')
  }
  if (name === 'run_query' || name === 'render_chart') {
    const partes: string[] = []
    const filtros = Array.isArray(input.filters) ? (input.filters as Record<string, unknown>[]) : []
    if (filtros.length) {
      partes.push(filtros.map((f) => `${f.field} ${f.op}${f.value === undefined ? '' : ` ${valorCurto(f.value)}`}`).join(' e '))
    }
    const grupo = Array.isArray(input.groupBy) ? input.groupBy : input.dimension ? [input.dimension] : []
    if (grupo.length) partes.push(`por ${grupo.join(', ')}`)
    return partes.length ? curto(partes.join(' · '), 220) : 'sem filtro'
  }
  return null
}

/** Quantas linhas/valores/conjuntos a ferramenta devolveu, quando dá para saber. */
export function linhasDoResultado(name: string, outcome: ToolOutcome): number | null {
  if (outcome.isError) return null
  try {
    const j = JSON.parse(outcome.content) as unknown
    if (name === 'run_query') return Number((j as { rowCount?: number }).rowCount ?? 0)
    if (name === 'list_field_values') return ((j as { values?: unknown[] }).values ?? []).length
    if (name === 'search_datasets' && Array.isArray(j)) return j.length
  } catch { /* conteúdo não-JSON: sem contagem */ }
  return null
}

// O que o modelo recebe quando as rodadas acabam. Ele já tem tudo que
// consultou no histórico; falta só a ordem de parar e responder.
export const FECHAMENTO = `

LIMITE DE CONSULTAS ATINGIDO NESTA PERGUNTA: você não pode chamar mais ferramentas.
Responda agora, só com o que as consultas acima mostraram:
- comece pelo que dá para afirmar (com os números que vieram de fato);
- diga em uma frase o que faltou descobrir e por quê (ex.: valor não encontrado, campo errado);
- sugira como a pessoa pode refazer a pergunta (ex.: citar o conjunto ou o valor exato).
Nunca invente números para completar a resposta.`

export function mensagemDeLimite(trace: TraceStep[], max: number): string {
  const erros = trace.filter((t) => t.erro).length
  return `Parei depois de ${trace.length} consulta(s), no limite de ${max} rodadas`
    + (erros ? `, sendo ${erros} com erro` : '')
    + '. Abra "o que eu consultei" abaixo para ver onde travei.'
    + (erros
      ? ' As consultas com erro indicam problema no conjunto, não na pergunta —'
      + ' tente a mesma consulta num Notebook para ver o erro completo.'
      : ' Se foram muitos conjuntos diferentes, aponte o conjunto certo na pergunta.')
}

export async function runAgent(o: {
  provider: AIProvider
  system: string
  messages: AiMessage[]
  tools: AiToolDef[]
  maxRounds: number
  exec: (call: AiToolCall) => Promise<ToolOutcome>
  onToolStart?: (call: AiToolCall) => void
  onOutcome?: (call: AiToolCall, outcome: ToolOutcome) => void
}): Promise<AgentResult> {
  const { provider, system, messages, tools } = o
  const trace: TraceStep[] = []

  for (let i = 0; i < o.maxRounds; i++) {
    const turn = await provider.chat(system, messages, tools)
    if (!turn.toolCalls.length) return { text: turn.text, trace, limitReached: false }
    messages.push({ role: 'assistant', content: turn.raw })
    // Todas as ferramentas do turno rodam e voltam juntas.
    const results = []
    for (const call of turn.toolCalls) {
      o.onToolStart?.(call)
      const outcome = await o.exec(call)
      o.onOutcome?.(call, outcome)
      trace.push({
        name: call.name,
        alvo: alvoDaTool(call.input),
        erro: !!outcome.isError,
        detalhe: detalheDaTool(call.name, call.input),
        linhas: linhasDoResultado(call.name, outcome),
        motivo: outcome.isError ? curto(outcome.content.replace(/^Erro:\s*/, ''), 200) : null,
      })
      results.push({ toolCallId: call.id, content: outcome.content, isError: outcome.isError })
    }
    messages.push(provider.toolResultMessage(results))
  }

  // Rodadas esgotadas: uma última chamada, sem ferramentas, para responder
  // com o que já se sabe. Se ela falhar ou vier vazia, sobra a mensagem que
  // ao menos aponta para o rastro.
  let text = ''
  try {
    const final = await provider.chat(system + FECHAMENTO, messages, tools, { toolChoice: 'none' })
    text = final.text.trim()
  } catch (e) {
    console.warn(`[ai] resposta final depois do limite falhou: ${(e as Error).message}`)
  }
  return { text: text || mensagemDeLimite(trace, o.maxRounds), trace, limitReached: true }
}
