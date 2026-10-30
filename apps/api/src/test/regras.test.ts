// ─────────────────────────────────────────────────────────────────────────
// Regra de atualização num lugar só (30/10/2026).
//
// A frequência de um conjunto passou a se escolher no próprio painel dele —
// cadência fixa OU agendamento, no mesmo campo — e a regra de todos ganhou
// uma tabela de leitura (GET /datasets/sync-rules). Estes testes passam pelas
// rotas reais, com a trava de master e o Postgres de verdade, porque o risco
// está justamente na junção: a constraint de pareamento cadência/agendamento
// e quem pode mexer na frequência de uma fonte.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, publishSource } from './harness.js'

let conn = ''
let ds = { id: '', slug: '' }
let agendamento = ''
const BASE = { syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'] }
const gravado = async () => (await db.query(
  'select sync_cadence, schedule_id from datasets where id = $1', [ds.id])).rows[0]

before(async () => {
  conn = await connectTestSource()
  await db.query(`create table fonte.regras as
    select g as id, timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em
      from generate_series(1, 5) g`)
  ds = await publishSource(conn, 'regras', { ...BASE, syncCadence: 'hourly' })
  const s = await as('admin').post('/api/v1/schedules', {
    name: 'Horário comercial', intervalMinutes: 30, startTime: '08:00', endTime: '18:00', weekdays: 62,
  })
  assert.equal(s.status, 201, JSON.stringify(s.body))
  agendamento = String(s.body.id)
})

after(shutdown)

describe('frequência no painel do conjunto', () => {
  it('o master põe o conjunto num agendamento pela regra dele, numa gravação só', async () => {
    const r = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, scheduleId: agendamento })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const g = await gravado()
    assert.equal(g.sync_cadence, 'schedule')
    assert.equal(String(g.schedule_id), agendamento)
  })

  it('salvar outra parte da regra sem mandar frequência mantém o agendamento', async () => {
    const r = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, watermarkLagMinutes: 60 })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(String((await gravado()).schedule_id), agendamento)
  })

  it('cadência fixa E agendamento juntos são recusados', async () => {
    const r = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, {
      ...BASE, syncCadence: 'daily', scheduleId: agendamento,
    })
    assert.equal(r.status, 400)
    assert.match(String(r.body.error), /uma frequência só/)
  })

  it('agendamento inexistente ou malformado vira "não encontrado", sem erro do Postgres', async () => {
    for (const scheduleId of ['00000000-0000-4000-8000-000000000000', 'nao-e-uuid']) {
      const r = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, scheduleId })
      assert.equal(r.status, 400, scheduleId)
      assert.equal(r.body.error, 'Agendamento não encontrado.', scheduleId)
    }
    assert.equal(String((await gravado()).schedule_id), agendamento, 'a recusa não pode ter mexido na linha')
  })

  it('admin sem master não muda a frequência de uma fonte por este caminho', async () => {
    const r = await as('admin').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, syncCadence: 'daily' })
    assert.equal(r.status, 403)
    assert.equal(String((await gravado()).schedule_id), agendamento)
  })

  it('escolher cadência fixa tira o conjunto do agendamento', async () => {
    const r = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, syncCadence: 'hourly' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const g = await gravado()
    assert.equal(g.sync_cadence, 'hourly')
    assert.equal(g.schedule_id, null)
  })
})

describe('tabela de regras (GET /datasets/sync-rules)', () => {
  it('mostra a regra inteira, com os rótulos dos campos e o agendamento', async () => {
    await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, { ...BASE, scheduleId: agendamento })
    const r = await as('admin').get('/api/v1/datasets/sync-rules')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const linha = r.body.datasets.find((d: { id: string }) => d.id === ds.id)
    assert.ok(linha, 'o conjunto publicado não está na tabela')
    assert.equal(linha.kind, 'source')
    assert.equal(linha.mode, 'incremental')
    assert.equal(linha.incrementalKey.key, 'criado_em')
    assert.deepEqual(linha.dedupeKeys.map((k: { key: string }) => k.key), ['id'])
    assert.equal(linha.cadence, 'schedule')
    assert.equal(linha.schedule.name, 'Horário comercial')
    assert.equal(linha.schedule.intervalMinutes, 30)
    assert.equal(linha.table, 'fonte.regras')
    assert.equal(linha.lastRun, null)
    assert.equal(linha.runs24h, 0)
  })

  it('é de admin: editor e leitor não veem', async () => {
    assert.equal((await as('editor').get('/api/v1/datasets/sync-rules')).status, 403)
    assert.equal((await as('viewer').get('/api/v1/datasets/sync-rules')).status, 403)
  })
})
