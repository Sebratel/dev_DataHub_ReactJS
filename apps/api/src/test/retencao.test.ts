// ─────────────────────────────────────────────────────────────────────────
// Prazo das conversas com a IA (D-MON-4, decidido na R6 de 13/11; MON-13):
// a conversa sai 30 dias depois da ÚLTIMA mensagem, e os totais ficam em
// ai_usage_daily — inclusive quando a própria pessoa apaga pela tela.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, USERS } from './harness.js'
import { purgeExpiredConversations } from '../modules/ai/retention.js'
import { diaLocalDe } from '../core/usage.js'

after(shutdown)

const DIA = 86_400_000
const atras = (dias: number) => new Date(Date.now() - dias * DIA)

type Msg = { role: 'user' | 'assistant'; dias: number; trace?: unknown[] }

/** Cria uma conversa com mensagens em datas escolhidas. */
async function conversa(email: string, criadaHa: number, atualizadaHa: number, msgs: Msg[]): Promise<string> {
  const t = (await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0].id
  const id = String((await db.query(
    `insert into conversations (tenant_id, user_email, title, created_at, updated_at)
     values ($1, $2, 'teste', $3, $4) returning id`,
    [t, email, atras(criadaHa), atras(atualizadaHa)],
  )).rows[0].id)
  for (const m of msgs) {
    await db.query(
      `insert into messages (conversation_id, role, content, trace, created_at) values ($1, $2, 'x', $3, $4)`,
      [id, m.role, m.trace ? JSON.stringify(m.trace) : null, atras(m.dias)],
    )
  }
  return id
}

const existe = async (id: string) => Boolean((await db.query(`select 1 from conversations where id = $1`, [id])).rowCount)
const totais = async (email: string, dias: number) => (await db.query(
  `select conversations, questions, answers, tool_calls, tool_errors from ai_usage_daily
    where user_email = $1 and day = $2::date`, [email, diaLocalDe(atras(dias))],
)).rows[0]

describe('D-MON-4 conversas da IA: 30 dias após a última mensagem', () => {
  it('a conversa parada há mais de 30 dias sai, com as mensagens, e os totais ficam', async () => {
    const id = await conversa(USERS.viewer, 45, 40, [
      { role: 'user', dias: 40 },
      { role: 'assistant', dias: 40, trace: [{ name: 'run_query', alvo: 'a', erro: false }, { name: 'run_query', alvo: 'b', erro: true }] },
      { role: 'user', dias: 40 },
      { role: 'assistant', dias: 40, trace: [{ name: 'search_datasets', alvo: null, erro: false }] },
    ])
    assert.ok(await purgeExpiredConversations() >= 1)
    assert.equal(await existe(id), false, 'a conversa vencida continua lá')
    assert.equal((await db.query(`select 1 from messages where conversation_id = $1`, [id])).rowCount, 0,
      'as mensagens não foram junto')
    const t = await totais(USERS.viewer, 40)
    assert.ok(t, 'os totais não ficaram')
    assert.deepEqual(
      [t.conversations, t.questions, t.answers, t.tool_calls, t.tool_errors].map(Number),
      [1, 2, 2, 3, 1],
    )
  })

  it('o prazo conta da ÚLTIMA mensagem: conversa antiga ainda em uso fica', async () => {
    // updated_at velho de propósito: a resposta que falha não atualiza a conversa.
    const emUso = await conversa(USERS.viewer, 60, 60, [{ role: 'user', dias: 60 }, { role: 'user', dias: 2 }])
    const recente = await conversa(USERS.viewer, 3, 3, [{ role: 'user', dias: 3 }])
    await purgeExpiredConversations()
    assert.equal(await existe(emUso), true, 'apagou conversa com mensagem de 2 dias atrás')
    assert.equal(await existe(recente), true, 'apagou conversa recente')
  })

  it('rodar de novo não apaga nem soma nada (idempotente)', async () => {
    const antes = await totais(USERS.viewer, 40)
    assert.equal(await purgeExpiredConversations(), 0)
    assert.deepEqual(await totais(USERS.viewer, 40), antes)
  })

  it('apagar pela tela também guarda os totais; outra pessoa não apaga', async () => {
    const id = await conversa(USERS.editor, 1, 1, [{ role: 'user', dias: 1 }, { role: 'assistant', dias: 1 }])
    assert.equal((await as('viewer').del(`/api/v1/ai/conversations/${id}`)).status, 200)
    assert.equal(await existe(id), true, 'a conversa de outra pessoa foi apagada')
    assert.equal(await totais(USERS.viewer, 1), undefined, 'contou para quem não é o dono')

    assert.equal((await as('editor').del(`/api/v1/ai/conversations/${id}`)).status, 200)
    assert.equal(await existe(id), false)
    const t = await totais(USERS.editor, 1)
    assert.deepEqual([t.conversations, t.questions, t.answers].map(Number), [1, 1, 1])
  })
})
