// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps (Data Hub embutido no Hub) e o modo "só pelo Hub".
//
// O token de lançamento é montado aqui do MESMO jeito que o hub-api monta
// (jsonwebtoken, HS256, { sub, email, name, appId }, 5 min): HMAC-SHA256 sobre
// cabeçalho.payload em base64url.
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { anon, idToken, shutdown, baseUrl, USERS, db } from './harness.js'

const SEGREDO = 'segredo-do-hub-so-de-teste'
const APP_ID = 'app-datahub-teste'

after(shutdown)
afterEach(() => { process.env.HUB_ONLY = 'false' })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

function tokenDoHub(over: Record<string, unknown> = {}, opts: { segredo?: string; alg?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const data = `${b64({ alg: opts.alg ?? 'HS256', typ: 'JWT' })}.${b64({
    sub: 'uid-hub-1', email: USERS.viewer, name: 'Pessoa do Hub', appId: APP_ID,
    iat: now, exp: now + 300, jti: randomUUID(), ...over,
  })}`
  const sig = createHmac('sha256', opts.segredo ?? SEGREDO).update(data).digest('base64url')
  return `${data}.${sig}`
}

async function trocar(token: string) {
  return anon.post<{ token?: string; expiresAt?: string; user?: { email: string; roles: string[] }; error?: string }>(
    '/api/v1/auth/hub', { token })
}

async function me(bearer: string) {
  const r = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${bearer}` } })
  return { status: r.status, body: await r.json() as { user?: { email: string; roles: string[] }; code?: string; error?: string } }
}

// Token do Firebase sempre diferente: o cache de token é por string, e dois
// idToken no mesmo segundo sairiam iguais.
const firebaseDe = (email: string) => idToken(email, { nonce: randomUUID() })

describe('entrada pelo Hub Apps', () => {
  it('HUB-01 /auth/config é público e diz como a tela deve se apresentar', async () => {
    const r = await anon.get('/api/v1/auth/config')
    assert.equal(r.status, 200)
    assert.equal(r.body.hubOnly, false)
    assert.equal(r.body.hubLogin, true)
    assert.match(r.body.hubUrl, /^https:\/\//)
  })

  it('HUB-02 token do Hub vira sessão do Data Hub, com o papel do banco', async () => {
    const r = await trocar(tokenDoHub())
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.user?.email, USERS.viewer)
    assert.deepEqual(r.body.user?.roles, ['viewer'])
    assert.ok(Date.parse(r.body.expiresAt!) > Date.now() + 7 * 3600_000, 'sessão de ~8 h')

    const sessao = await me(r.body.token!)
    assert.equal(sessao.status, 200)
    assert.equal(sessao.body.user?.email, USERS.viewer)
  })

  it('HUB-03 a sessão leva o papel de admin de quem é admin no Data Hub', async () => {
    const r = await trocar(tokenDoHub({ email: USERS.admin }))
    assert.equal(r.status, 200)
    assert.ok(r.body.user?.roles.includes('admin'))
  })

  it('HUB-04 o mesmo token do Hub não entra duas vezes', async () => {
    const t = tokenDoHub()
    assert.equal((await trocar(t)).status, 200)
    const segunda = await trocar(t)
    assert.equal(segunda.status, 401)
    assert.match(segunda.body.error!, /já foi usado/)
  })

  it('HUB-05 token emitido para OUTRO app do Hub é recusado', async () => {
    const r = await trocar(tokenDoHub({ appId: 'outro-app' }))
    assert.equal(r.status, 403)
  })

  it('HUB-06 assinatura com outro segredo, alg diferente ou vencido: recusado', async () => {
    assert.equal((await trocar(tokenDoHub({}, { segredo: 'outro-segredo' }))).status, 401)
    assert.equal((await trocar(tokenDoHub({}, { alg: 'none' }))).status, 401)
    const now = Math.floor(Date.now() / 1000)
    const vencido = await trocar(tokenDoHub({ iat: now - 600, exp: now - 300 }))
    assert.equal(vencido.status, 401)
    assert.match(vencido.body.error!, /venceu/)
  })

  it('HUB-07 conta fora do domínio é recusada mesmo com token válido do Hub', async () => {
    const r = await trocar(tokenDoHub({ email: USERS.externo }))
    assert.equal(r.status, 403)
  })

  it('HUB-08 o token do Hub não vale como sessão, e a sessão não vale como token do Hub', async () => {
    const lancamento = tokenDoHub()
    assert.equal((await me(lancamento)).status, 401)

    const sessao = (await trocar(tokenDoHub())).body.token!
    assert.equal((await trocar(sessao)).status, 401)
  })

  it('HUB-09 sessão adulterada (e-mail trocado) é recusada', async () => {
    const sessao = (await trocar(tokenDoHub())).body.token!
    const [h, p, s] = sessao.split('.')
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
    const outra = `${h}.${b64({ ...payload, email: USERS.master })}.${s}`
    assert.equal((await me(outra)).status, 401)
  })

  it('HUB-10 a entrada fica registrada na auditoria', async () => {
    await trocar(tokenDoHub({ email: USERS.editor }))
    let achou = false
    for (let i = 0; i < 20 && !achou; i++) {
      const rows = (await db.query(
        `select 1 from audit_logs where action = 'auth.login_hub' and user_email = $1`, [USERS.editor])).rows
      achou = rows.length > 0
      if (!achou) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(achou, 'auth.login_hub não registrado')
  })
})

describe('modo só pelo Hub (HUB_ONLY)', () => {
  it('HUB-11 desligado: login direto pelo Google segue valendo', async () => {
    assert.equal((await me(firebaseDe(USERS.viewer))).status, 200)
  })

  it('HUB-12 ligado: login direto de quem não é master recebe 403 HUB_ONLY', async () => {
    process.env.HUB_ONLY = 'true'
    const r = await me(firebaseDe(USERS.viewer))
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'HUB_ONLY')
    assert.match(r.body.error!, /Hub Apps/)
    // admin que não é master também passa pelo Hub
    assert.equal((await me(firebaseDe(USERS.admin))).status, 403)
  })

  it('HUB-13 ligado: o master continua entrando direto (caminho de recuperação)', async () => {
    process.env.HUB_ONLY = 'true'
    assert.equal((await me(firebaseDe(USERS.master))).status, 200)
  })

  it('HUB-14 ligado: quem entra pelo Hub trabalha normalmente', async () => {
    process.env.HUB_ONLY = 'true'
    const r = await trocar(tokenDoHub({ email: USERS.viewer2 }))
    assert.equal(r.status, 200)
    assert.equal((await me(r.body.token!)).status, 200)
    const cfg = await anon.get('/api/v1/auth/config')
    assert.equal(cfg.body.hubOnly, true)
  })
})
