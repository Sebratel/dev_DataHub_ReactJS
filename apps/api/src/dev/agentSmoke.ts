// Smoke do loop do agente (modules/ai/agent.ts) com um provedor FALSO — sem
// rede, sem chave, sem banco.
//
// O que ele protege é o comportamento que fazia o assistente "falhar sempre":
// esgotadas as rodadas, a pessoa recebia só "parei depois de 9 consultas" e
// tudo o que tinha dado certo era jogado fora. Agora há uma última chamada,
// com as ferramentas PROIBIDAS, que responde com o que já se sabe. E o rastro
// tem de dizer o que foi tentado — filtro, linhas que voltaram, erro.
//
// Uso: npm run agent:smoke --workspace apps/api
import type { AIProvider, AiMessage, AiToolDef, ChatOptions, AiTurn } from '../modules/ai/provider.js'
import type { ToolOutcome } from '../modules/ai/tools.js'
import { runAgent, detalheDaTool, linhasDoResultado, FECHAMENTO } from '../modules/ai/agent.js'
import { palavrasDeBusca } from '../modules/ai/tools.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `obtido ${JSON.stringify(got)}, esperado ${JSON.stringify(want)}`)

const TOOLS: AiToolDef[] = [{ name: 'run_query', description: 'x', inputSchema: { type: 'object' } }]

/** Provedor que sempre pede uma consulta, até receber toolChoice 'none'. */
function provedor(final: string | Error, primeiraResposta?: string) {
  const chamadas: { system: string; opts?: ChatOptions; nMsgs: number }[] = []
  let n = 0
  const p: AIProvider = {
    name: 'falso', model: 'falso',
    isConfigured: () => true,
    listModels: async () => [],
    toolResultMessage: (results) => ({ role: 'user', content: results }),
    async chat(system: string, messages: AiMessage[], _tools: AiToolDef[], opts?: ChatOptions): Promise<AiTurn> {
      chamadas.push({ system, opts, nMsgs: messages.length })
      if (opts?.toolChoice === 'none') {
        if (final instanceof Error) throw final
        return { text: final, toolCalls: [], raw: null }
      }
      if (primeiraResposta) return { text: primeiraResposta, toolCalls: [], raw: null }
      n++
      return {
        text: '', raw: { n },
        toolCalls: [{ id: `c${n}`, name: 'run_query', input: {
          dataset: 'db-matrix', filters: [{ field: 'tag', op: 'contains', value: 'desbloqueio de confianca' }], groupBy: ['tag'],
        } }],
      }
    },
  }
  return { p, chamadas }
}

const vazio = async (): Promise<ToolOutcome> => ({ content: JSON.stringify({ rowCount: 0, rows: [] }) })

console.log('\n── resposta normal ──')
{
  const { p, chamadas } = provedor('nunca', 'São 42.')
  const r = await runAgent({ provider: p, system: 'S', messages: [], tools: TOOLS, maxRounds: 3, exec: vazio })
  eq('responde de primeira, sem limite', [r.text, r.limitReached, r.trace.length], ['São 42.', false, 0])
  check('uma chamada só', chamadas.length === 1)
}

console.log('\n── limite: ainda responde ──')
{
  const { p, chamadas } = provedor('Não achei a tag: o filtro não casou com nenhuma linha.')
  const r = await runAgent({ provider: p, system: 'S', messages: [], tools: TOOLS, maxRounds: 3, exec: vazio })
  check('a resposta é a do modelo, não a mensagem de falha', r.text.startsWith('Não achei a tag'), r.text)
  check('marca que bateu no limite', r.limitReached)
  eq('3 rodadas + 1 chamada final', chamadas.length, 4)
  const ultima = chamadas[chamadas.length - 1]
  check('a final proíbe ferramentas (toolChoice none)', ultima.opts?.toolChoice === 'none')
  check('a final manda parar e responder', ultima.system.endsWith(FECHAMENTO))
  check('a final leva o histórico das consultas', ultima.nMsgs === 6, `${ultima.nMsgs} mensagens`)
  eq('o rastro tem as 3 consultas', r.trace.length, 3)
  eq('o rastro diz o filtro tentado', r.trace[0].detalhe, 'tag contains "desbloqueio de confianca" · por tag')
  eq('e que nada voltou', r.trace[0].linhas, 0)
}
{
  const { p } = provedor('')
  const r = await runAgent({ provider: p, system: 'S', messages: [], tools: TOOLS, maxRounds: 2, exec: vazio })
  check('resposta final vazia → mensagem que aponta o rastro', r.text.startsWith('Parei depois de 2 consulta(s)'), r.text)
}
{
  const { p } = provedor(new Error('provedor fora'))
  const r = await runAgent({ provider: p, system: 'S', messages: [], tools: TOOLS, maxRounds: 2, exec: vazio })
  check('resposta final com erro → mensagem que aponta o rastro, sem derrubar o chat', r.text.startsWith('Parei depois de'), r.text)
}
{
  const { p } = provedor('')
  const erro = async (): Promise<ToolOutcome> => ({ content: 'Erro: Campo desconhecido: tags', isError: true })
  const r = await runAgent({ provider: p, system: 'S', messages: [], tools: TOOLS, maxRounds: 1, exec: erro })
  eq('o erro vira motivo no rastro, sem o prefixo', r.trace[0].motivo, 'Campo desconhecido: tags')
  check('e conta como erro na mensagem', r.text.includes('sendo 1 com erro'), r.text)
}

console.log('\n── descrição dos passos ──')
eq('valores: campo e busca', detalheDaTool('list_field_values', { field: 'tag', search: 'desbloq' }), 'campo tag · busca "desbloq"')
eq('consulta sem filtro', detalheDaTool('run_query', { dataset: 'x' }), 'sem filtro')
eq('lista no filtro aparece encurtada',
  detalheDaTool('run_query', { filters: [{ field: 'tag', op: 'in', value: ['A', 'B', 'C', 'D', 'E'] }] }),
  'tag in ["A", "B", "C", "D", …]')
eq('gráfico: dimensão', detalheDaTool('render_chart', { dimension: 'cidade', filters: [] }), 'por cidade')
eq('schema não tem detalhe', detalheDaTool('get_dataset_schema', { slug: 'x' }), null)
eq('linhas de valores', linhasDoResultado('list_field_values', { content: JSON.stringify({ values: [1, 2, 3] }) }), 3)
eq('erro não tem contagem', linhasDoResultado('run_query', { content: 'x', isError: true }), null)

console.log('\n── busca de valores ──')
eq('sem acento, sem caixa, sem palavra vazia', palavrasDeBusca('Desbloqueio de Confiança'), ['desbloqueio', 'confianca'])
eq('"_" e espaço valem igual', palavrasDeBusca('segunda_via de BOLETO'), ['segunda', 'via', 'boleto'])
eq('palavra de uma letra sai', palavrasDeBusca('2 via'), ['via'])

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
