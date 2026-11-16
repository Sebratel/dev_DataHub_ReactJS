// ─────────────────────────────────────────────────────────────────────────
// Alertas no Google Chat (MON-03; canal decidido na R6, D-MON-3). Até a R6,
// disco cheio, envio ao Databricks falhando e endpoint fora apareciam só no
// sino, para quem abrisse o Data Hub. Agora viram alerta — e só na TROCA de
// estado, para um problema que dura não virar um aviso a cada verificação.
//
// Sem webhook no laboratório, o alerta fica registrado como 'no-channel': é o
// registro que se confere aqui.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { db, shutdown, seedDataset } from './harness.js'
import { checkDiskAlert } from '../modules/alerts/disk.js'
import { runDueHealthChecks } from '../connectors/healthChecks.js'
import { avisarTrocaDatabricks } from '../modules/databricks/publish.js'

let tenantId = ''
before(async () => { tenantId = String((await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0].id) })
after(shutdown)

const alertas = async (kind: string) => (await db.query(
  `select key, title, body, status from alert_events where tenant_id = $1 and kind = $2 order by created_at`,
  [tenantId, kind],
)).rows

describe('MON-03 / D-MON-3 disco do lake', () => {
  it('avisa ao passar do limite, uma vez, e de novo só quando volta', async () => {
    await checkDiskAlert(92)
    const altos = await alertas('disk-high')
    assert.equal(altos.length, 1)
    assert.match(altos[0].title, /92%/)
    assert.equal(altos[0].status, 'no-channel')

    await checkDiskAlert(95)
    assert.equal((await alertas('disk-high')).length, 1, 'o mesmo problema avisou duas vezes')

    await checkDiskAlert(60)
    await checkDiskAlert(61)
    assert.equal((await alertas('disk-ok')).length, 1, 'a volta não avisou, ou avisou duas vezes')
  })

  it('abaixo do limite, sem aviso anterior, não diz nada', async () => {
    const antes = (await alertas('disk-ok')).length
    await checkDiskAlert(40)
    assert.equal((await alertas('disk-ok')).length, antes)
  })
})

describe('MON-03 / D-MON-3 endpoint fora do ar', () => {
  let srv: Server
  let status = 503
  let checkId = ''
  before(async () => {
    srv = createServer((_q, r) => { r.statusCode = status; r.end() })
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/health`
    checkId = String((await db.query(
      `insert into health_checks (tenant_id, name, url, interval_minutes, enabled, created_by)
       values ($1, 'API de cobrança', $2, 5, true, 'teste') returning id`, [tenantId, url],
    )).rows[0].id)
  })
  after(() => new Promise<void>((ok) => srv.close(() => ok())))

  // A cadência é de 5 min: zerar o "última execução" faz a verificação vencer agora.
  const verifica = async () => {
    await db.query(`update health_checks set last_run_at = null where id = $1`, [checkId])
    await runDueHealthChecks()
  }

  it('uma falha só não avisa; a segunda seguida avisa; a terceira não repete', async () => {
    await verifica()
    assert.equal((await alertas('health-down')).length, 0, 'um soluço virou alerta')
    await verifica()
    const fora = await alertas('health-down')
    assert.equal(fora.length, 1)
    assert.equal(fora[0].title, 'API de cobrança: fora do ar')
    assert.match(fora[0].body, /HTTP 503/)
    await verifica()
    assert.equal((await alertas('health-down')).length, 1)
  })

  it('voltar a responder avisa uma vez', async () => {
    status = 200
    await verifica()
    await verifica()
    const volta = await alertas('health-up')
    assert.equal(volta.length, 1)
    assert.equal(volta[0].title, 'API de cobrança: no ar de novo')
  })
})

describe('MON-03 / D-MON-3 envio ao Databricks', () => {
  let ds = { id: '', slug: 'envio-dbx' }
  before(async () => {
    ds = { id: await seedDataset({ slug: 'envio-dbx', fields: [{ key: 'id', type: 'number' }], rowsSql: 'select 1 as id' }), slug: 'envio-dbx' }
  })
  const run = async (status: 'SUCCESS' | 'FAILED' | 'SKIPPED', segundos: number) => {
    await db.query(
      `insert into databricks_sync_runs (id, dataset_id, dataset_slug, status, mode, started_at, error_message)
       values ($1, $2, $3, $4, 'SNAPSHOT', $5, $6)`,
      [randomUUID(), ds.id, ds.slug, status, new Date(Date.now() - 3_600_000 + segundos * 1000),
       status === 'FAILED' ? 'token expirado' : null],
    )
    await avisarTrocaDatabricks(ds, status === 'FAILED' ? 'token expirado' : null)
  }

  it('avisa na 2ª falha seguida (o "nada mudou" não interrompe a conta), não na 3ª, e avisa a volta', async () => {
    await run('SUCCESS', 1)
    await run('FAILED', 2)
    assert.equal((await alertas('databricks-failed')).length, 0, 'uma falha só virou alerta')
    await run('SKIPPED', 3)
    await run('FAILED', 4)
    const falha = await alertas('databricks-failed')
    assert.equal(falha.length, 1)
    assert.match(falha[0].body, /token expirado/)
    await run('FAILED', 5)
    assert.equal((await alertas('databricks-failed')).length, 1, 'repetiu o aviso')
    await run('SUCCESS', 6)
    assert.equal((await alertas('databricks-ok')).length, 1)
  })
})
