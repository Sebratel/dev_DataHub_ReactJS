// ─────────────────────────────────────────────────────────────────────────
// O assistente de dados: prompt, mapa do catálogo e histórico. O chat
// (aiRouter) e a avaliação (evaluation.ts) usam ESTE módulo — o que se mede
// é exatamente o que as pessoas usam.
//
// Mudança de 27/11/2026: o prompt antigo mandava responder em 1 a 3 frases,
// em texto cru, e proibia SQL. Servia para "quantos ativos?" e falhava em
// qualquer pergunta de analista. Agora ele trabalha como um: acha o conjunto
// pelo mapa, entende antes de consultar (get_dataset_schema traz armadilhas,
// valores e o SQL do cálculo), consulta em SQL com JOIN, confere, e responde
// curto quando a pergunta é curta e em relatório quando pedem análise.
// ─────────────────────────────────────────────────────────────────────────
import type { SessionUser } from '@datahub/shared'
import { db } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { lakeRefs } from '../transform/derive.js'
import type { AIProvider, AiMessage, AiToolCall } from './provider.js'
import { CHAT_TOOLS, executeTool, type ToolOutcome } from './tools.js'
import { runAgent, type AgentResult, type TraceStep } from './agent.js'
import { REGRAS_GERAIS, mapaDosPacotes } from './knowledge.js'

export const INSTRUCOES = `Você é o analista de dados do Data Hub da Sebratel. Responda sempre em português do Brasil.

COMO TRABALHAR (como um analista experiente da casa):
1. Entenda a pergunta: indicador, período e recorte. Se for ambígua, adote a leitura mais comum na empresa e diga qual adotou; só pergunte de volta se for impossível seguir.
2. Ache o conjunto: comece pelo MAPA abaixo — são conjuntos tratados, com as regras do negócio já aplicadas. Use search_datasets só se o mapa não cobrir o assunto.
3. Entenda o conjunto antes de consultar: get_dataset_schema mostra o que é uma linha, as armadilhas, os campos com os valores reais e o SQL que calcula o conjunto. Leia as armadilhas.
4. Consulte com run_sql (SQL do DuckDB; pode juntar conjuntos, usar CTE e janela). Agregue no SQL. Antes de filtrar por um texto (status, motivo, tag, cidade, tipo), confira a grafia exata nos valores do get_dataset_schema ou com list_field_values ("desbloqueio de confiança" pode estar gravado como ISA_DESBLOQUEIO_CONFIANÇA; um filtro com a grafia errada devolve zero linhas sem avisar). Para a frequência de uma tag ou categoria, list_field_values já devolve quantas linhas têm cada valor e separa as células com várias tags ("A || B").
5. Confira antes de responder: a ordem de grandeza faz sentido? O período está certo? O mês corrente é parcial? Se dá para cruzar com outro conjunto, cruze. Resultado vazio ou estranho quase sempre é filtro errado: investigue em vez de responder "não há dados".
6. Erro de consulta: leia a mensagem, corrija e tente de novo.

COMO RESPONDER:
- Pergunta direta ("quantos…?", "qual…?"): comece pelo número, em 1 a 3 frases, dizendo o período e a regra usada (ex.: "contratos ativos em 27/11/2026, sem telefonia").
- Pedido de análise, relatório, comparação ou "por quê": use Markdown — um título curto (##), um resumo de 2 ou 3 linhas, tabela(s) com os números (| coluna | coluna |) e uma seção "Leitura" com 2 a 4 pontos de negócio. Termine com as ressalvas que importam.
- Se pedirem para guardar, compartilhar, um relatório ou um notebook, salve a análise com create_notebook (texto + os SQL que você usou) e dê o link no formato [Abrir notebook](/notebooks/slug).
- Gráfico: use render_chart quando ajudar a ver tendência ou comparação; depois comente em uma frase.
- Números no padrão brasileiro: 1.234.567; 12,3%; R$ 1.234,56. Arredonde para o que importa.
- Todo número vem de uma consulta desta conversa. Nunca invente; estimativa só dizendo que é estimativa e como foi feita.
- Se o dado não existe no Data Hub, diga isso e o que seria preciso para ter.
- Não mostre SQL na resposta, a não ser que peçam.`

/** Data de hoje no fuso da empresa — "este mês" depende disso. */
function hojeAqui(): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full' }).format(new Date())
}

/**
 * O mapa que vai no prompt: os conjuntos dos pacotes que existem no lake E que
 * a pessoa lê, e os oficiais. Sem ele o modelo garimpava o catálogo inteiro por
 * busca semântica a cada pergunta — e escolhia a cópia crua em vez da tratada.
 */
export async function mapaDoCatalogo(user: SessionUser): Promise<string> {
  const refs = await lakeRefs(user.tenant, { user })
  const noLake = new Set(refs.filter((r) => !r.alias).map((r) => r.slug))
  const pacotes = mapaDosPacotes().filter((p) => noLake.has(p.slug))
  const ids = refs.filter((r) => !r.alias && r.id).map((r) => String(r.id))
  const oficiais = ids.length
    ? (await db.query(
        `select d.slug, d.name, d.description from datasets d join tenants t on t.id = d.tenant_id
          where t.slug = $1 and d.official order by d.name`,
        [user.tenant],
      )).rows.filter((r) => noLake.has(String(r.slug)) && !pacotes.some((p) => p.slug === r.slug))
    : []

  const linhas: string[] = []
  if (pacotes.length) {
    linhas.push('Conjuntos tratados (prata = uma linha por contrato/fatura/protocolo; ouro = indicador pronto):')
    let dominio = ''
    for (const p of pacotes) {
      if (p.dominio !== dominio) { dominio = p.dominio; linhas.push(`[${dominio}]`) }
      linhas.push(`- ${p.slug} — ${p.nome}: ${p.descricao}`)
    }
  }
  if (oficiais.length) {
    linhas.push('Outros conjuntos oficiais:')
    for (const o of oficiais.slice(0, 40)) {
      const desc = String(o.description ?? '').trim()
      linhas.push(`- ${String(o.slug).replace(/-/g, '_')} — ${o.name}${desc ? `: ${desc.slice(0, 160)}` : ''}`)
    }
  }
  if (!linhas.length) return 'MAPA: nenhum conjunto tratado instalado; use search_datasets para achar os conjuntos.'
  return `MAPA (você tem ${noLake.size} conjuntos no total; os demais aparecem em search_datasets):\n${linhas.join('\n')}`
}

export async function montaSistema(user: SessionUser): Promise<string> {
  return `${INSTRUCOES}\n\nHoje é ${hojeAqui()}.\n\n${REGRAS_GERAIS}\n\n${await mapaDoCatalogo(user)}`
}

// Quanto SQL de respostas anteriores volta para o modelo numa pergunta de
// continuação ("e por cidade?"). Sem isto ele refazia a investigação do zero.
const MAX_SQL_NO_HISTORICO = 3_000

export interface MensagemSalva {
  role: string
  content: string | null
  trace?: unknown
}

/** Mensagens salvas → histórico do provedor, com o SQL que cada resposta usou. */
export function historicoParaModelo(salvas: MensagemSalva[]): AiMessage[] {
  return salvas
    .filter((m) => m.content)
    .map((m) => {
      let content = String(m.content)
      if (m.role === 'assistant') {
        let trace: TraceStep[] = []
        try { trace = (typeof m.trace === 'string' ? JSON.parse(m.trace) : m.trace) as TraceStep[] ?? [] } catch { /* rastro ilegível */ }
        const sqls = (Array.isArray(trace) ? trace : []).filter((t) => t.name === 'run_sql' && !t.erro && t.sql).map((t) => String(t.sql))
        if (sqls.length) {
          let bloco = sqls.join(';\n\n')
          if (bloco.length > MAX_SQL_NO_HISTORICO) bloco = `${bloco.slice(0, MAX_SQL_NO_HISTORICO)}\n-- … (cortado)`
          content += `\n\n[Consultas SQL que usei nesta resposta — reaproveite se a próxima pergunta continuar o assunto:]\n${bloco}`
        }
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content }
    })
}

export interface Resposta extends AgentResult {
  charts: Record<string, unknown>[]
  notebooks: { slug: string; name: string }[]
}

/** Uma pergunta (com o histórico já montado) do começo ao fim. */
export async function responder(o: {
  provider: AIProvider
  user: SessionUser
  messages: AiMessage[]
  onToolStart?: (call: AiToolCall) => void
  onChart?: (chart: Record<string, unknown>) => void
  onNotebook?: (nb: { slug: string; name: string }) => void
}): Promise<Resposta> {
  const charts: Record<string, unknown>[] = []
  const notebooks: { slug: string; name: string }[] = []
  const r = await runAgent({
    provider: o.provider,
    system: await montaSistema(o.user),
    messages: o.messages,
    tools: CHAT_TOOLS,
    maxRounds: config.ai.maxRounds,
    maxMs: config.ai.maxSeconds * 1000,
    exec: (call) => executeTool(call.name, call.input, o.user),
    onToolStart: o.onToolStart,
    onOutcome: (_call, outcome: ToolOutcome) => {
      if (outcome.chart) { charts.push(outcome.chart); o.onChart?.(outcome.chart) }
      if (outcome.notebook) { notebooks.push(outcome.notebook); o.onNotebook?.(outcome.notebook) }
    },
  })
  return { ...r, charts, notebooks }
}
