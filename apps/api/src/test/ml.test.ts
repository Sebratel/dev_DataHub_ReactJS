// ─────────────────────────────────────────────────────────────────────────
// Modelos de ML: a previsão em lote respeita o acesso de quem pede (S-05 do
// comitê, SEG-11). A resposta da previsão traz LINHAS do conjunto (as colunas
// pedidas mais o score). Um modelo criado por outra pessoa sobre um conjunto
// privado não pode virar porta para lê-lo.
//
// Uso: npm run test:it --workspace apps/api   (precisa do Postgres local)
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, shutdown, seedDataset } from './harness.js'

const MODELO = 'teste-ml-privado'

before(async () => {
  // Conjunto PRIVADO do editor2: o editor (e o viewer) não têm concessão.
  await seedDataset({
    slug: 'teste-ml-privado',
    visibility: 'private',
    owner: 'editor2',
    fields: [{ key: 'id', type: 'number' }, { key: 'x', type: 'number' }, { key: 'y', type: 'number' }],
    rowsSql: `select g as id, cast(g % 7 as double) as x, case when g % 7 > 3 then 1 else 0 end as y
                from range(1, 81) t(g)`,
  })
  const dono = as('editor2')
  const criar = await dono.post('/api/v1/ml', {
    slug: MODELO, name: 'TESTE-COMITE ml privado', task: 'binary',
    featureSql: 'select id, x, y from teste_ml_privado', targetColumn: 'y', excludedColumns: ['id'],
    maxRows: 100, holdoutPct: 20,
  })
  assert.equal(criar.status, 201, JSON.stringify(criar.body))
  const treino = await dono.post(`/api/v1/ml/${MODELO}/train`)
  assert.equal(treino.status, 200, JSON.stringify(treino.body))
  const promo = await as('admin').post(`/api/v1/ml/${MODELO}/promote/${treino.body.versionId}`)
  assert.equal(promo.status, 200, JSON.stringify(promo.body))
})
after(shutdown)

describe('S-05 previsão de ML com as permissões de quem pede', () => {
  it('S-05 o dono do conjunto prevê normalmente', async () => {
    const r = await as('editor2').post(`/api/v1/ml/${MODELO}/predict`, { limit: 5, keyColumns: ['id'] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.rows.length, 5)
    assert.ok('id' in r.body.rows[0] && 'probabilidade' in r.body.rows[0], JSON.stringify(r.body.rows[0]))
  })

  it('S-05 quem não lê o conjunto não recebe as linhas pelo modelo de outra pessoa', async () => {
    const r = await as('editor').post(`/api/v1/ml/${MODELO}/predict`, { limit: 5, keyColumns: ['id'] })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /não tem acesso a: teste-ml-privado/)
    assert.equal(r.body.rows, undefined)
  })

  it('S-05 a pontuação de linhas enviadas pelo próprio chamador segue liberada (não lê o lake)', async () => {
    const r = await as('editor').post(`/api/v1/ml/${MODELO}/score`, { rows: [{ id: 1, x: 5 }, { id: 2, x: 1 }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.predictions.length, 2)
  })
})
