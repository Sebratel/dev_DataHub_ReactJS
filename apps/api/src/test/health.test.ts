// ─────────────────────────────────────────────────────────────────────────
// D-12 do comitê (DSP-14 · MON-10): o /api/health confere o banco de verdade.
// Antes ele respondia "ok" com o banco fora — a plataforma parecia no ar, tudo
// dava erro e ninguém era avisado. E banco fora no boot deixava a API
// degradada para sempre. O banco "cai" aqui trocando o "select 1" por uma
// falha (__setDbPingForTest): o arquivo roda num processo só dele.
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, anon, shutdown, waitFor } from './harness.js'
import { isDbAvailable, startDbWatch, __setDbPingForTest } from '../db/pool.js'

let pararVigia: (() => void) | null = null
after(async () => {
  pararVigia?.()
  __setDbPingForTest(null)
  await shutdown()
})

const fora = () => Promise.reject(new Error('banco fora (teste)'))

describe('D-12 saúde de verdade', () => {
  it('D-12 com o banco no ar, /api/health responde 200', async () => {
    const r = await anon.get('/api/health')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.metadataDb, 'ok')
  })

  it('D-12 com o banco fora, /api/health responde 503; o /live (do contêiner) segue 200', async () => {
    __setDbPingForTest(fora)
    const r = await anon.get('/api/health')
    assert.equal(r.status, 503, JSON.stringify(r.body))
    assert.equal(r.body.metadataDb, 'offline')
    assert.equal(r.body.ok, false)
    assert.equal((await anon.get('/api/health/live')).status, 200, 'o contêiner não pode ser dado como morto')
  })

  it('D-12 o vigia marca o banco fora (rotas respondem 503) e religa sozinho quando ele volta', async () => {
    __setDbPingForTest(fora)
    pararVigia = startDbWatch({ intervalMs: 50 })
    assert.ok(await waitFor(async () => !isDbAvailable(), 5_000), 'o vigia não percebeu o banco fora')
    const ml = await as('editor').get('/api/v1/ml')
    assert.equal(ml.status, 503, JSON.stringify(ml.body))

    __setDbPingForTest(null) // o banco "volta"
    assert.ok(await waitFor(async () => isDbAvailable(), 5_000), 'o vigia não religou')
    assert.equal((await anon.get('/api/health')).status, 200)
    assert.equal((await as('editor').get('/api/v1/ml')).status, 200)
  })
})
