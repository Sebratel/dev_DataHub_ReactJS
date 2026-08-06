// Chat IA — conversas persistidas + loop agêntico com progresso via SSE.
// Cada mensagem do usuário roda o loop (máx. 8 iterações de tools); eventos
// intermediários informam o que a IA está consultando; o texto final e os
// gráficos são persistidos e enviados no fim.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import type { AiMessage } from './provider.js'
import { activeProvider } from './providerStore.js'
import { AI_TOOLS, executeTool } from './tools.js'

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
- Monte consultas com run_query (QueryDef estruturado — você nunca escreve SQL).
- Todo número citado deve vir de um run_query desta conversa. Nunca invente valores.
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
    `select id, role, content, chart, created_at from messages
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
    let finalText = ''

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const turn = await provider.chat(SYSTEM_PROMPT, messages, AI_TOOLS)
      if (!turn.toolCalls.length) {
        finalText = turn.text
        break
      }
      messages.push({ role: 'assistant', content: turn.raw })
      // Executa TODAS as tools do turno e devolve os resultados juntos.
      const results = []
      for (const call of turn.toolCalls) {
        send('tool', { name: call.name, input: call.input })
        const outcome = await executeTool(call.name, call.input, req.user!)
        if (outcome.chart) {
          charts.push(outcome.chart)
          send('chart', outcome.chart)
        }
        results.push({ toolCallId: call.id, content: outcome.content, isError: outcome.isError })
      }
      messages.push(provider.toolResultMessage(results))
      if (i === MAX_TOOL_ITERATIONS - 1) {
        finalText = 'Atingi o limite de consultas desta resposta. Refine a pergunta para eu continuar.'
      }
    }

    const saved = (await db.query(
      `insert into messages (conversation_id, role, content, chart) values ($1, 'assistant', $2, $3)
       returning id`,
      [conv.id, finalText, charts.length ? JSON.stringify(charts) : null],
    )).rows[0]
    await db.query(`update conversations set updated_at = now() where id = $1`, [conv.id])
    await audit(req, 'ai.message', { type: 'conversation', id: String(conv.id) }, { tools: charts.length })

    send('done', { id: saved.id, text: finalText, charts })
  } catch (e) {
    send('error', { error: (e as Error).message })
  } finally {
    res.end()
  }
})
