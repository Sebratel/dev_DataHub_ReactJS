// ─────────────────────────────────────────────────────────────────────────
// M-05 do comitê (MON-02 · SEG-12): entrada e tentativa negada ficam na
// auditoria. Uma "auth.login" por pessoa por dia; cada "auth.denied" com o
// motivo (e-mail de fora, não verificado, "só pelo Hub", token do Hub
// recusado), sem repetir a mesma recusa em sequência.
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { as, anon, idToken, baseUrl, db, shutdown, waitFor, USERS } from './harness.js'

after(shutdown)
afterEach(() => { process.env.HUB_ONLY = 'false' })

const me = (token: string) => fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })

async function linhas(action: string, email: string | null): Promise<Array<{ detail: Record<string, unknown> }>> {
  const r = email === null
    ? await db.query(`select detail from audit_logs where action = $1 and user_email is null order by created_at`, [action])
    : await db.query(`select detail from audit_logs where action = $1 and user_email = $2 order by created_at`, [action, email])
  return r.rows.map((x) => ({ detail: typeof x.detail === 'string' ? JSON.parse(x.detail) : x.detail }))
}

describe('M-05 entradas e recusas na auditoria', () => {
  it('M-05 uma "auth.login" por pessoa por dia, por mais requisições que faça', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await as('viewer2').get('/api/v1/auth/me')).status, 200)
    await waitFor(async () => (await linhas('auth.login', USERS.viewer2)).length > 0)
    const l = await linhas('auth.login', USERS.viewer2)
    assert.equal(l.length, 1, JSON.stringify(l))
    assert.equal(l[0].detail.via, 'google')
  })

  it('M-05 e-mail de fora do domínio é recusado e registrado, uma vez só na sequência', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await me(idToken(USERS.externo, { nonce: randomUUID() }))).status, 401)
    }
    await waitFor(async () => (await linhas('auth.denied', USERS.externo)).length > 0)
    const l = await linhas('auth.denied', USERS.externo)
    assert.equal(l.length, 1, 'a mesma recusa em sequência vira uma linha só')
    assert.equal(l[0].detail.motivo, 'dominio')
  })

  it('M-05 e-mail não verificado é registrado', async () => {
    const email = 'nao.verificado.m05@sebratel.com.br'
    assert.equal((await me(idToken(email, { email_verified: false }))).status, 401)
    const l = await waitFor(async () => { const x = await linhas('auth.denied', email); return x.length ? x : null })
    assert.equal(l?.[0].detail.motivo, 'email_nao_verificado')
  })

  it('M-05 login direto com o modo "só pelo Hub" é registrado', async () => {
    process.env.HUB_ONLY = 'true'
    assert.equal((await me(idToken(USERS.editor2, { nonce: randomUUID() }))).status, 403)
    const l = await waitFor(async () => { const x = await linhas('auth.denied', USERS.editor2); return x.length ? x : null })
    assert.equal(l?.[0].detail.motivo, 'hub_only')
  })

  it('M-05 token do Hub recusado é registrado (sem e-mail: o token não valeu)', async () => {
    const r = await anon.post('/api/v1/auth/hub', { token: 'a.b.c' })
    assert.equal(r.status, 401)
    const l = await waitFor(async () => {
      const x = (await linhas('auth.denied', null)).filter((y) => y.detail.motivo === 'token_do_hub')
      return x.length ? x : null
    })
    assert.equal(l?.[0].detail.via, 'hub')
  })

  it('M-05 token só vencido não vira recusa (o navegador renova sozinho)', async () => {
    const email = 'vencido.m05@sebratel.com.br'
    const agora = Math.floor(Date.now() / 1000)
    assert.equal((await me(idToken(email, { iat: agora - 7200, exp: agora - 3600 }))).status, 401)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await linhas('auth.denied', email)).length, 0)
  })
})
