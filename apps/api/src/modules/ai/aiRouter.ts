// Chat IA — conversas persistidas + loop agêntico com progresso via SSE.
// Cada mensagem do usuário roda o loop (agent.ts: máx. 8 rodadas de tools e
// uma resposta final, mesmo no limite); eventos intermediários informam o que
// a IA está consultando; o texto final e os gráficos são persistidos e
// enviados no fim.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import type { AiMessage } from './provider.js'
import { activeProvider } from './providerStore.js'
import { AI_TOOLS, executeTool } from './tools.js'
import { runAgent } from './agent.js'

export const aiRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const authed = [requireAuth(), requireDb]

const MAX_TOOL_ITERATIONS = 8

const SYSTEM_PROMPT = `Você é o assistente de dados do Data Hub da Sebratel (provedor de internet).
Responda SEMPRE em português do Brasil.

Estilo (IMPORTANTE):
- Seja resumido, objetivo e direto. Responda a pergunta em 1 a 3 frases; só detalhe se pedirem.
- Comece pela resposta (o número ou a conclusão), sem preâmbulo.
- Se pedirem uma informação específica (ex.: "quantos clientes ativos?"), responda só isso — não liste o catálogo inteiro.
- Escreva em TEXTO SIMPLES. Não use Markdown: nada de **negrito**, títulos com #, tabelas ou emojis decorativos. O front mostra o texto cru, então esses símbolos aparecem literalmente e poluem a resposta.
- Para uma lista curta, use hífen (-) no começo da linha e poucos itens.

Como trabalhar:
- Use search_datasets para descobrir os conjuntos de dados e get_dataset_schema antes de consultar.
- Quando a pergunta cita um VALOR de texto (tag, status, motivo, plano, cidade, categoria), nunca chute como ele está gravado: chame list_field_values com search no campo provável e use o valor exato que voltar. "Desbloqueio de confiança" pode estar gravado como ISA_DESBLOQUEIO_CONFIANÇA, e um filtro com a grafia errada devolve zero linhas sem avisar.
- Se a busca de valores não achar nada, tente uma palavra só ou outro campo de texto do MESMO conjunto antes de trocar de conjunto.
- Para frequência de uma tag ou categoria, list_field_values já devolve quantas linhas têm cada valor — muitas vezes é a resposta inteira.
- Monte consultas com run_query (QueryDef estruturado — você nunca escreve SQL). Agregue no run_query (select com agg + groupBy) em vez de trazer linhas soltas.
- Todo número citado deve vir de um run_query ou list_field_values desta conversa. Nunca invente valores.
- Quando um gráfico ajudar, use render_chart (ele já exibe o gráfico; depois resuma o insight em UMA frase, sem repetir os pontos).
- Se um conjunto não estiver sincronizado ou o dado não existir, diga isso em uma frase e sugira o caminho.

Contexto de negócio: a Sebratel é um provedor de internet. As perguntas costumam ser sobre clientes (ativos, cancelados), contratos, serviços/planos e conexões. Ao responder indicadores da empresa, traga o número e uma leitura curta de negócio — não um relatório longo.`

// ─── Conversas ─────────────────────────────────────────────────
aiRouter.get('/conversations', ...authed, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.title, c.updated_at from conversations c
      join tenants t on t.id = c.tenant_id
     where t.slug = $1 and c.user_email = $2 order by c.updated_at desc limit 50`,
    [req.user!.tenant, req.user!.email],
  )).rows
  res.json({ conversations: rows })
})

aiRouter.post('/conversations', ...authed, async (req, res) => {
  const row = (await db.query(
    `insert into conversations (tenant_id, user_email)
     select t.id, $1 from tenants t where t.slug = $2 returning id, title`,
    [req.user!.email, req.user!.tenant],
  )).rows[0]
  res.status(201).json({ id: row.id, title: row.title })
})

aiRouter.get('/conversations/:id', ...authed, async (req, res) => {
  const conv = (await db.query(
    `select c.id, c.title from conversations c join tenants t on t.id = c.tenant_id
     where t.slug = $1 and c.user_email = $2 and c.id = $3`,
    [req.user!.tenant, req.user!.email, req.params.id],
  )).rows[0]
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada.' })
  const messages = (await db.query(
    `select id, role, content, chart, trace, created_at from messages
      where conversation_id = $1 order by created_at`,
    [req.params.id],
  )).rows
  res.json({ conversation: conv, messages })
})

aiRouter.delete('/conversations/:id', ...authed, async (req, res) => {
  await db.query(
    `delete from conversations c using tenants t
      where c.tenant_id = t.id and t.slug = $1 and c.user_email = $2 and c.id = $3`,
    [req.user!.tenant, req.user!.email, req.params.id],
  )
  res.json({ ok: true })
})

// ─── Mensagem + loop agêntico (SSE) ────────────────────────────
aiRouter.post('/conversations/:id/messages', ...authed, async (req, res) => {
  const provider = activeProvider(req.user!.tenant)
  if (!provider?.isConfigured()) {
    return res.status(503).json({ error: 'IA não configurada. Um administrador precisa cadastrar um provedor em Administração › Provedores de IA (Anthropic, OpenAI ou Gemini).' })
  }
  const text = String((req.body ?? {}).text ?? '').trim()
  if (!text) return res.status(400).json({ error: 'Mensagem vazia.' })

  const conv = (await db.query(
    `select c.id, c.title from conversations c join tenants t on t.id = c.tenant_id
     where t.slug = $1 and c.user_email = $2 and c.id = $3`,
    [req.user!.tenant, req.user!.email, req.params.id],
  )).rows[0]
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada.' })

  // SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    await db.query(
      `insert into messages (conversation_id, role, content) values ($1, 'user', $2)`,
      [conv.id, text],
    )
    // Título da conversa = primeira pergunta (truncada).
    if (conv.title === 'Nova conversa') {
      await db.query(`update conversations set title = $2 where id = $1`, [conv.id, text.slice(0, 60)])
    }

    // Histórico persistido → mensagens do provedor (texto simples; os blocos
    // de tool do turno atual são mantidos apenas em memória durante o loop).
    const history = (await db.query(
      `select role, content from messages where conversation_id = $1 order by created_at`,
      [conv.id],
    )).rows
    const messages: AiMessage[] = history
      .filter((m) => m.content)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }))

    const charts: Record<string, unknown>[] = []
    // O rastro (o que a IA consultou, com filtros, linhas e erros) vem do
    // loop: sem ele ninguém — nem quem usa, nem quem mantém — consegue saber
    // POR QUE uma resposta acabou no limite.
    const { text: finalText, trace, limitReached } = await runAgent({
      provider,
      system: SYSTEM_PROMPT,
      messages,
      tools: AI_TOOLS,
      maxRounds: MAX_TOOL_ITERATIONS,
      exec: (call) => executeTool(call.name, call.input, req.user!),
      onToolStart: (call) => send('tool', { name: call.name, input: call.input }),
      onOutcome: (_call, outcome) => {
        if (outcome.chart) {
          charts.push(outcome.chart)
          send('chart', outcome.chart)
        }
      },
    })

    const saved = (await db.query(
      `insert into messages (conversation_id, role, content, chart, trace)
       values ($1, 'assistant', $2, $3, $4) returning id`,
      [conv.id, finalText, charts.length ? JSON.stringify(charts) : null,
       trace.length ? JSON.stringify(trace) : null],
    )).rows[0]
    await db.query(`update conversations set updated_at = now() where id = $1`, [conv.id])
    await audit(req, 'ai.message', { type: 'conversation', id: String(conv.id) }, { tools: charts.length })

    send('done', { id: saved.id, text: finalText, charts, trace, limitReached })
  } catch (e) {
    send('error', { error: (e as Error).message })
  } finally {
    res.end()
  }
})
