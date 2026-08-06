// Construtor de widgets com IA (Fase 4) — o "brilho" do dashboards_IA embutido.
// A pessoa descreve o que quer; a IA descobre o conjunto, lê o schema real,
// valida a consulta no DuckDB e devolve widgets prontos (propose_widgets) para
// adicionar à aba. O modelo NUNCA escreve SQL nem vê linha crua — só o catálogo
// de campos e specs declarativas, validadas antes de chegar ao usuário.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import type { AiMessage } from '../ai/provider.js'
import { activeProvider } from '../ai/providerStore.js'
import { WIDGET_BUILDER_TOOLS, executeTool } from '../ai/tools.js'

export const aiWidgetsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

const MAX_TOOL_ITERATIONS = 8

const BUILDER_PROMPT = `Você monta WIDGETS de dashboard no Data Hub da Sebratel (provedor de internet). Responda em português do Brasil.

Seu trabalho é traduzir o pedido da pessoa em um ou mais widgets. Você NUNCA escreve SQL nem código: descreve o visual (tipo, dimensão, medida) e o app agrega os dados.

Como trabalhar:
- Use search_datasets para achar o(s) conjunto(s) certos e get_dataset_schema para ver os campos REAIS (use o "key" do campo, não o rótulo).
- Use SOMENTE conjuntos e campos que existam no schema. Nunca invente nome de campo, agregação ou conjunto.
- Se tiver dúvida se há dados, valide com run_query antes.
- No FIM, chame propose_widgets UMA vez com a lista de widgets. Se algum for inválido, a tool devolve o erro — corrija e chame de novo.
- Prefira de 1 a 4 widgets bem escolhidos, com títulos curtos. Depois de propose_widgets, escreva UMA frase dizendo o que montou.

Tipos: kpi (número único, sem dimension), bar, line, area, pie, table.
Agregações: count, count_distinct, sum, avg, min, max.
Estilo opcional por widget (style): {color, numberFormat: 'number'|'currency'|'percent', showDataLabels, showLegend, target, subtitle}.`

// Dono, admin ou convidado com level 'edit' pode construir widgets no dashboard.
async function canEditDashboard(req: Request, dashboardId: string): Promise<boolean> {
  if (req.user!.roles.includes('admin')) return true
  const row = (await db.query('select owner_email from dashboards where id = $1', [dashboardId])).rows[0]
  if (!row) return false
  if (row.owner_email === req.user!.email) return true
  const grant = (await db.query(
    `select 1 from dashboard_grants g
      where g.dashboard_id = $1 and g.level = 'edit' and (
        g.grantee_email = $2
        or g.team_id in (select team_id from team_members where user_email = $2))`,
    [dashboardId, req.user!.email],
  )).rows[0]
  return !!grant
}

aiWidgetsRouter.post('/:id/ai/build', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const provider = activeProvider(req.user!.tenant)
  if (!provider?.isConfigured()) {
    return res.status(503).json({ error: 'IA não configurada. Um administrador precisa cadastrar um provedor em Administração › Provedores de IA (Anthropic, OpenAI ou Gemini).' })
  }
  if (!(await canEditDashboard(req, req.params.id))) {
    return res.status(403).json({ error: 'Apenas o dono (ou admin) pode construir widgets.' })
  }
  const prompt = String((req.body ?? {}).prompt ?? '').trim()
  if (!prompt) return res.status(400).json({ error: 'Descreva o que você quer no painel.' })

  // Escopo opcional: os conjuntos que a IA pode usar nesta tela (inclui derivados).
  const rawSlugs = Array.isArray((req.body ?? {}).datasetSlugs)
    ? ((req.body as { datasetSlugs: unknown[] }).datasetSlugs).map((s) => String(s)).filter(Boolean)
    : []
  const scope = rawSlugs.length ? new Set<string>(rawSlugs) : undefined
  const systemPrompt = scope
    ? `${BUILDER_PROMPT}\n\nESCOPO OBRIGATÓRIO: use SOMENTE estes conjuntos (não chame search_datasets; chame get_dataset_schema neles para ver os campos): ${[...scope].join(', ')}.`
    : BUILDER_PROMPT

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const messages: AiMessage[] = [{ role: 'user', content: prompt }]
    let proposed: Record<string, unknown>[] = []
    let finalText = ''

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const turn = await provider.chat(systemPrompt, messages, WIDGET_BUILDER_TOOLS)
      if (!turn.toolCalls.length) {
        finalText = turn.text
        break
      }
      messages.push({ role: 'assistant', content: turn.raw })
      const results = []
      for (const call of turn.toolCalls) {
        send('tool', { name: call.name, input: call.input })
        const outcome = await executeTool(call.name, call.input, req.user!, scope)
        if (outcome.widgets) {
          proposed = outcome.widgets
          send('widgets', outcome.widgets)
        }
        results.push({ toolCallId: call.id, content: outcome.content, isError: outcome.isError })
      }
      messages.push(provider.toolResultMessage(results))
      if (i === MAX_TOOL_ITERATIONS - 1) {
        finalText = 'Atingi o limite de tentativas. Refine o pedido para eu continuar.'
      }
    }

    await audit(req, 'dashboards.ai.build', { type: 'dashboard', id: req.params.id }, { widgets: proposed.length })
    send('done', { text: finalText, widgets: proposed })
  } catch (e) {
    send('error', { error: (e as Error).message })
  } finally {
    res.end()
  }
})
