// Chat IA — conversas persistidas + loop agêntico com progresso via SSE.
// Cada mensagem do usuário roda o assistente (assistant.ts: prompt, mapa do
// catálogo e o loop de agent.ts, com o fôlego de config.ai e uma resposta
// final mesmo no limite); eventos intermediários informam o que a IA está
// consultando; o texto final, os gráficos e o rastro são persistidos e
// enviados no fim.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { activeProvider } from './providerStore.js'
import { responder, historicoParaModelo } from './assistant.js'
import { foldAndDeleteConversation } from './retention.js'

export const aiRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const authed = [requireAuth(), requireDb]

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
  const conv = (await db.query(
    `select c.id from conversations c join tenants t on t.id = c.tenant_id
     where t.slug = $1 and c.user_email = $2 and c.id = $3`,
    [req.user!.tenant, req.user!.email, req.params.id],
  )).rows[0]
  // Apagar pela tela também guarda os totais (D-MON-4): o uso do mês não
  // pode encolher porque a pessoa limpou a lista.
  if (conv) await foldAndDeleteConversation(String(conv.id))
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
    // O histórico leva o SQL que cada resposta anterior usou: "e por cidade?"
    // continua a análise em vez de recomeçá-la.
    const history = (await db.query(
      `select role, content, trace from messages where conversation_id = $1 order by created_at`,
      [conv.id],
    )).rows
    const messages = historicoParaModelo(history as never)

    // O rastro (o que a IA consultou, com filtros, SQL, linhas e erros) vem do
    // loop: sem ele ninguém — nem quem usa, nem quem mantém — consegue saber
    // POR QUE uma resposta acabou no limite.
    const { text: finalText, trace, limitReached, charts, notebooks } = await responder({
      provider,
      user: req.user!,
      messages,
      onToolStart: (call) => send('tool', { name: call.name, input: call.input }),
      onChart: (chart) => send('chart', chart),
      onNotebook: (nb) => send('notebook', nb),
    })

    const saved = (await db.query(
      `insert into messages (conversation_id, role, content, chart, trace)
       values ($1, 'assistant', $2, $3, $4) returning id`,
      [conv.id, finalText, charts.length ? JSON.stringify(charts) : null,
       trace.length ? JSON.stringify(trace) : null],
    )).rows[0]
    await db.query(`update conversations set updated_at = now() where id = $1`, [conv.id])
    await audit(req, 'ai.message', { type: 'conversation', id: String(conv.id) }, {
      tools: trace.length, charts: charts.length, notebooks: notebooks.length,
    })

    send('done', { id: saved.id, text: finalText, charts, trace, limitReached, notebooks })
  } catch (e) {
    send('error', { error: (e as Error).message })
  } finally {
    res.end()
  }
})
