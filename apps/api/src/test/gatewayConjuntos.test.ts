// ─────────────────────────────────────────────────────────────────────────
// Gateway › Conjuntos (pedido de 26/11/2026): quais conjuntos saem do Data
// Hub por fora, consolidados — quem PODE ler (API de leitura, token com o
// conjunto no escopo) e quem LEU de fato nos últimos 30 dias.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, anon, shutdown, seedDataset, waitFor } from './harness.js'

let tokenLido = ''

before(async () => {
  await seedDataset({
    slug: 'gw-lido', fields: [{ key: 'id', type: 'number' }, { key: 'nome' }],
    rowsSql: `select * from (values (1, 'a'), (2, 'b')) t(id, nome)`,
  })
  await seedDataset({
    slug: 'gw-so-api', fields: [{ key: 'id', type: 'number' }],
    rowsSql: `select * from (values (1)) t(id)`,
  })
  await seedDataset({
    slug: 'gw-fora', fields: [{ key: 'id', type: 'number' }],
    rowsSql: `select * from (values (1)) t(id)`,
  })
  const t = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE Power BI Financeiro', datasetSlugs: ['gw-lido'] })
  assert.equal(t.status, 201, JSON.stringify(t.body))
  tokenLido = t.body.token
  const tudo = await as('admin').post('/api/v1/credentials', { name: 'TESTE-COMITE token sem escopo', datasetSlugs: [] })
  assert.equal(tudo.status, 201, JSON.stringify(tudo.body))
  const p = await as('admin').post('/api/v1/products', { kind: 'read', name: 'TESTE-COMITE API só leitura', datasetSlug: 'gw-so-api' })
  assert.equal(p.status, 201, JSON.stringify(p.body))
})

after(shutdown)

describe('Gateway › Conjuntos', () => {
  it('quem leu, por onde e quando; o exposto sem leitura; e o token que lê tudo à parte', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await anon.get('/api/public/v1/datasets/gw-lido/rows?limit=1', tokenLido)).status, 200)
    }
    // O uso é gravado depois que a resposta sai (best-effort): espera chegar.
    const r = await waitFor(async () => {
      const x = await as('admin').get('/api/v1/gateway/datasets')
      return (x.body.datasets as any[] | undefined)?.find((d) => d.slug === 'gw-lido')?.calls30d === 3 ? x : null
    }, 5_000)
    assert.ok(r, 'as 3 leituras não apareceram')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const por = Object.fromEntries((r.body.datasets as any[]).map((d) => [d.slug, d]))

    const lido = por['gw-lido']
    assert.ok(lido, JSON.stringify(r.body))
    assert.equal(lido.calls30d, 3)
    assert.deepEqual(lido.consumers30d, [{ name: 'TESTE-COMITE Power BI Financeiro', calls: 3 }])
    assert.deepEqual(lido.tokens.map((x: any) => x.name), ['TESTE-COMITE Power BI Financeiro'])
    assert.ok(lido.lastReadAt)

    const soApi = por['gw-so-api']
    assert.ok(soApi, 'a API de leitura expõe o conjunto mesmo sem leitura')
    assert.equal(soApi.calls30d, 0)
    assert.deepEqual(soApi.apis.map((x: any) => x.name), ['TESTE-COMITE API só leitura'])

    assert.equal(por['gw-fora'], undefined, 'conjunto sem API nem token com escopo não entra na lista')
    assert.ok((r.body.allAccessTokens as any[]).some((x) => x.name === 'TESTE-COMITE token sem escopo'))
    assert.ok(r.body.trackingSince, 'o primeiro dia de registro vai junto')
    assert.equal(r.body.datasets[0].slug, 'gw-lido', 'o mais lido vem primeiro')
  })

  it('token revogado sai de "quem pode ler", e só admin vê a lista', async () => {
    const lista = await as('admin').get('/api/v1/credentials')
    const t = (lista.body.credentials as any[]).find((c) => c.name === 'TESTE-COMITE Power BI Financeiro')
    assert.equal((await as('admin').patch(`/api/v1/credentials/${t.id}`, { revoked: true })).status, 200)
    const r = await as('admin').get('/api/v1/gateway/datasets')
    const lido = (r.body.datasets as any[]).find((d) => d.slug === 'gw-lido')
    assert.deepEqual(lido.tokens, [], 'revogado não alcança mais')
    assert.equal(lido.calls30d, 3, 'o histórico de leitura fica')
    for (const who of ['editor', 'viewer'] as const) {
      assert.equal((await as(who).get('/api/v1/gateway/datasets')).status, 403, who)
    }
  })
})
