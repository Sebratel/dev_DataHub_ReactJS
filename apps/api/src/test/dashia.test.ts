// ─────────────────────────────────────────────────────────────────────────
// Token do quadro dos Painéis (dashia). O contrato é o que o dashia confere em
// server/hubSso.mjs (verifyDatahubLaunchToken).
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { anon, idToken, shutdown, baseUrl, USERS } from './harness.js'

const SEGREDO_DASHIA = 'segredo-dos-paineis-so-de-teste-com-32-caracteres-ou-mais'
const SEGREDO_HUB = 'segredo-do-hub-so-de-teste' // o mesmo do harness
const APP_ID = 'app-datahub-teste'

after(shutdown)
afterEach(() => { process.env.DASHIA_SSO_SECRET = '' })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

function tokenDoHub(email: string): string {
  const now = Math.floor(Date.now() / 1000)
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: 'uid-hub-dashia', email, name: 'Pessoa do Hub', appId: APP_ID, iat: now, exp: now + 300, jti: randomUUID(),
  })}`
  return `${data}.${createHmac('sha256', SEGREDO_HUB).update(data).digest('base64url')}`
}

async function sessaoDoHub(email: string): Promise<string> {
  const r = await anon.post<{ token?: string }>('/api/v1/auth/hub', { token: tokenDoHub(email) })
  assert.equal(r.status, 200)
  return r.body.token!
}

async function pedir(bearer?: string) {
  const r = await fetch(`${baseUrl}/api/v1/dashia/sso-token`, {
    method: 'POST',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  })
  return { status: r.status, body: await r.json() as { token?: string; expiresAt?: string; code?: string } }
}

function abrir(token: string, segredo = SEGREDO_DASHIA) {
  const [h, p, s] = token.split('.')
  const esperado = createHmac('sha256', segredo).update(`${h}.${p}`).digest('base64url')
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string },
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    assinaturaOk: s === esperado,
  }
}

describe('token dos Painéis (dashia)', () => {
  it('DSH-01 sem login: 401', async () => {
    process.env.DASHIA_SSO_SECRET = SEGREDO_DASHIA
    assert.equal((await pedir()).status, 401)
  })

  it('DSH-02 sessão do Hub: token HS256 com via hub, iss/aud e 300 s', async () => {
    process.env.DASHIA_SSO_SECRET = SEGREDO_DASHIA
    const r = await pedir(await sessaoDoHub(USERS.viewer))
    assert.equal(r.status, 200)
    const t = abrir(r.body.token!)
    assert.equal(t.assinaturaOk, true)
    assert.equal(t.header.alg, 'HS256')
    assert.equal(t.payload.iss, 'data-hub')
    assert.equal(t.payload.aud, 'dashia')
    assert.equal(t.payload.via, 'hub')
    assert.equal(t.payload.email, USERS.viewer)
    assert.equal(t.payload.sub, USERS.viewer)
    assert.equal(Number(t.payload.exp) - Number(t.payload.iat), 300)
    assert.ok(Math.abs(Number(t.payload.iat) - Date.now() / 1000) < 10)
    assert.equal(abrir(r.body.token!, 'outro-segredo').assinaturaOk, false)
  })

  it('DSH-03 login direto (Google): via google; dois pedidos, dois tokens', async () => {
    process.env.DASHIA_SSO_SECRET = SEGREDO_DASHIA
    const bearer = idToken(USERS.editor, { nonce: randomUUID() })
    const a = await pedir(bearer)
    const b = await pedir(bearer)
    assert.equal(a.status, 200)
    assert.equal(abrir(a.body.token!).payload.via, 'google')
    assert.notEqual(a.body.token, b.body.token)
  })

  it('DSH-04 sem segredo (ou curto): 503 DASHIA_SSO_OFF', async () => {
    const bearer = await sessaoDoHub(USERS.viewer2)
    process.env.DASHIA_SSO_SECRET = ''
    let r = await pedir(bearer)
    assert.equal(r.status, 503)
    assert.equal(r.body.code, 'DASHIA_SSO_OFF')
    process.env.DASHIA_SSO_SECRET = 'curto'
    r = await pedir(bearer)
    assert.equal(r.status, 503)
  })
})
