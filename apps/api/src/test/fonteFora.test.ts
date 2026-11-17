// ─────────────────────────────────────────────────────────────────────────
// Fonte fora do ar não pausa os conjuntos (incidente de 17/11/2026).
//
// O Postgres do Voalle recusou conexão por alguns minutos às 08:51. Três
// recusas seguidas pausaram todos os conjuntos da fonte, e eles não voltaram
// quando ela voltou. Aqui a fonte de teste passa a recusar conexão (porta
// fechada) e depois volta: o conjunto não pode ser pausado, o aviso sai uma
// vez por fonte, e a volta é automática. Erro de verdade continua pausando.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, fonteDb, publishSource, syncAndWait, waitFor, TEST_DB } from './harness.js'
import { config } from '../core/config.js'
import {
  errorText, isSourceUnreachable, resetSourceOutages, resumeSourceOutagePauses, sourceWaitUntil,
} from '../modules/sync/sourceOutage.js'

let conn = ''
before(async () => { conn = await connectTestSource() })
after(shutdown)

const estado = async (id: string) => (await db.query(
  `select sync_failures, sync_paused_reason from datasets where id = $1`, [id])).rows[0]
const alertas = async (kind: string) => (await db.query(
  `select title, body from alert_events where kind = $1 order by created_at`, [kind])).rows
const esperaAlertas = async (kind: string, n: number) =>
  (await waitFor(async () => { const a = await alertas(kind); return a.length >= n ? a : null }, 10_000)) ?? await alertas(kind)

/** Aponta a conexão de teste para uma porta fechada, ou de volta para o banco. */
async function fonte(no_ar: boolean): Promise<void> {
  const c = config.datahubPg
  const r = await as('admin').patch(`/api/v1/connections/${conn}`, {
    kind: 'postgres', name: 'TESTE-COMITE fonte',
    host: no_ar ? c.host : '127.0.0.1', port: no_ar ? c.port : 1,
    database: TEST_DB, username: c.user, password: c.password,
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

describe('Fonte fora do ar (incidente de 17/11)', () => {
  it('o que é fonte inalcançável e o que não é', () => {
    for (const e of [
      'connect ECONNREFUSED 186.219.128.248:5432',
      'connect ETIMEDOUT 10.0.0.5:3306',
      'getaddrinfo ENOTFOUND srd.interno',
      'connect EHOSTUNREACH 10.0.0.9:5432',
      'the database system is starting up',
      'Connection terminated due to connection timeout',
      'Failed to connect to sqlsrv:1433 in 15000ms',
    ]) assert.ok(isSourceUnreachable(e), e)
    for (const e of [
      'relation "erp.contracts" does not exist',
      'canceling statement due to statement timeout',
      'read ETIMEDOUT',
      'Connection terminated unexpectedly',
      'syntax error at or near "from"',
    ]) assert.ok(!isSourceUnreachable(e), e)
    const agregado = Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:5432'),
      new Error('connect ECONNREFUSED 127.0.0.1:5432')], ''), { code: 'ECONNREFUSED' })
    assert.match(errorText(agregado), /ECONNREFUSED 127\.0\.0\.1/, 'a mensagem vazia do AggregateError some')
  })

  it('recusas seguidas não pausam; um aviso por fonte; a volta encerra a espera e avisa', async () => {
    resetSourceOutages()
    await fonteDb.query(`create table fonte.pedidos as select g as id from generate_series(1, 10) g`)
    const ds = await publishSource(conn, 'pedidos', { syncMode: 'snapshot' })
    await syncAndWait(ds.id)

    await fonte(false)
    for (let i = 0; i < 4; i++) await syncAndWait(ds.id).catch(() => { /* recusa esperada */ })
    const run = (await db.query(
      `select status, error from sync_runs where dataset_id = $1 order by started_at desc limit 1`, [ds.id])).rows[0]
    assert.equal(run.status, 'error')
    assert.match(String(run.error), /ECONNREFUSED/)
    const e = await estado(ds.id)
    assert.equal(e.sync_paused_reason, null, 'pausou por fonte fora do ar')
    assert.equal(Number(e.sync_failures), 0, 'recusa contou para a pausa')
    assert.ok(sourceWaitUntil(conn), 'a conexão não entrou em espera')
    assert.equal((await esperaAlertas('source-down', 1)).length, 1, 'um aviso só, por fonte')

    await fonte(true)
    await syncAndWait(ds.id)
    assert.equal(sourceWaitUntil(conn), null, 'a espera não acabou com a volta')
    const volta = await esperaAlertas('source-up', 1)
    assert.equal(volta.length, 1)
    assert.match(String(volta[0].title), /^Fonte de volta: /)
  })

  it('pausado pela regra antiga por fonte fora volta sozinho; pausado por erro de verdade, não', async () => {
    await fonteDb.query(`create table fonte.itens as select g as id from generate_series(1, 5) g`)
    await fonteDb.query(`create table fonte.notas_velhas as select g as id from generate_series(1, 5) g`)
    const fora = await publishSource(conn, 'itens', { syncMode: 'snapshot' })
    const quebrado = await publishSource(conn, 'notas_velhas', { syncMode: 'snapshot' })
    const pausa = (erro: string) => `Pausado automaticamente após 3 falhas seguidas. Último erro: ${erro} — insistir…`
    await db.query(`update datasets set sync_failures = 3, sync_paused_reason = $2 where id = $1`,
      [fora.id, pausa('connect ECONNREFUSED 186.219.128.248:5432')])
    await db.query(`update datasets set sync_failures = 3, sync_paused_reason = $2 where id = $1`,
      [quebrado.id, pausa('relation "fonte.notas_velhas" does not exist')])

    assert.ok(await resumeSourceOutagePauses() >= 1)
    assert.equal((await estado(fora.id)).sync_paused_reason, null, 'o pausado por fonte fora não voltou')
    assert.equal(Number((await estado(fora.id)).sync_failures), 0)
    assert.match(String((await estado(quebrado.id)).sync_paused_reason), /does not exist/, 'retomou um erro de verdade')
  })
})
