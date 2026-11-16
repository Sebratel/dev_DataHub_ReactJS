// ─────────────────────────────────────────────────────────────────────────
// Prazo das conversas com a IA (D-MON-4, decidido na R6 de 13/11; achado
// MON-13): a conversa é apagada 30 dias depois da última mensagem, e os
// totais ficam em ai_usage_daily (ver migration 045).
//
// O prazo conta da ÚLTIMA mensagem, e não de cada uma: apagar só as mensagens
// velhas de uma conversa em uso deixaria o histórico começando por uma
// resposta da IA, e o provedor recusa histórico que não começa pela pessoa.
//
// Toda exclusão de conversa passa por foldAndDeleteConversation — a rotina e
// o botão da tela. Sem isso, apagar a conversa pela tela apagaria também o
// uso dela, e o total do mês sairia menor do que foi.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { diaLocalDe } from '../../core/usage.js'

export const AI_CONVERSATION_DAYS = 30
const LOTE = 200

interface Totais { questions: number; answers: number; toolCalls: number; toolErrors: number }

function passos(trace: unknown): { erro?: unknown }[] {
  let t = trace
  if (typeof t === 'string') { try { t = JSON.parse(t) } catch { return [] } }
  return Array.isArray(t) ? t as { erro?: unknown }[] : []
}

/**
 * Soma a conversa nos totais e a apaga, na mesma transação: ou os dois
 * acontecem, ou nenhum. Devolve false se a conversa já não existia.
 */
export async function foldAndDeleteConversation(conversationId: string): Promise<boolean> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const conv = (await client.query(
      `select tenant_id, user_email from conversations where id = $1`, [conversationId],
    )).rows[0]
    if (!conv) { await client.query('rollback'); return false }

    const porDia = new Map<string, Totais>()
    for (const m of (await client.query(
      `select role, trace, created_at from messages where conversation_id = $1`, [conversationId],
    )).rows) {
      const dia = diaLocalDe(new Date(m.created_at as string))
      const t = porDia.get(dia) ?? { questions: 0, answers: 0, toolCalls: 0, toolErrors: 0 }
      if (m.role === 'user') t.questions++
      else if (m.role === 'assistant') t.answers++
      const p = passos(m.trace)
      t.toolCalls += p.length
      t.toolErrors += p.filter((s) => s?.erro).length
      porDia.set(dia, t)
    }
    for (const [dia, t] of porDia) {
      await client.query(
        `insert into ai_usage_daily (tenant_id, day, user_email, conversations, questions, answers, tool_calls, tool_errors)
         values ($1, $2::date, $3, 1, $4, $5, $6, $7)
         on conflict (tenant_id, day, user_email) do update set
           conversations = ai_usage_daily.conversations + excluded.conversations,
           questions = ai_usage_daily.questions + excluded.questions,
           answers = ai_usage_daily.answers + excluded.answers,
           tool_calls = ai_usage_daily.tool_calls + excluded.tool_calls,
           tool_errors = ai_usage_daily.tool_errors + excluded.tool_errors`,
        [conv.tenant_id, dia, conv.user_email, t.questions, t.answers, t.toolCalls, t.toolErrors],
      )
    }
    // As mensagens vão junto (on delete cascade).
    const apagou = (await client.query(`delete from conversations where id = $1`, [conversationId])).rowCount
    if (!apagou) { await client.query('rollback'); return false }
    await client.query('commit')
    return true
  } catch (e) {
    await client.query('rollback').catch(() => { /* a conexão já caiu */ })
    throw e
  } finally {
    client.release()
  }
}

/** Apaga as conversas paradas há mais de 30 dias. Idempotente; roda de hora em hora. */
export async function purgeExpiredConversations(now = new Date()): Promise<number> {
  if (!isDbAvailable()) return 0
  const limite = new Date(now.getTime() - AI_CONVERSATION_DAYS * 86_400_000)
  let total = 0
  for (;;) {
    const vencidas = (await db.query(
      `select c.id from conversations c
        where c.updated_at < $1
          and not exists (select 1 from messages m where m.conversation_id = c.id and m.created_at >= $1)
        order by c.updated_at limit ${LOTE}`,
      [limite],
    )).rows
    let apagadas = 0
    for (const v of vencidas) {
      // Uma conversa que falha não segura as outras; ela volta na próxima hora.
      try {
        if (await foldAndDeleteConversation(String(v.id))) apagadas++
      } catch (e) {
        console.warn(`[ia] não foi possível apagar a conversa ${String(v.id)}: ${(e as Error).message}`)
      }
    }
    total += apagadas
    if (vencidas.length < LOTE || !apagadas) break
  }
  if (total) console.log(`[ia] ${total} conversa(s) parada(s) há mais de ${AI_CONVERSATION_DAYS} dias apagada(s); os totais ficam.`)
  return total
}
