// ─────────────────────────────────────────────────────────────────────────
// Saúde da plataforma (MON-14, D-MON-5 B; T-MON-08): "o que precisa de
// atenção agora" numa tela só, montado do ESTADO atual — e o sino do
// cabeçalho, que é o canal de aviso dentro do próprio sistema.
//
// Cada problema é provocado no laboratório e tem de aparecer na lista; e,
// resolvida a causa, tem de sair dela sozinho.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, fonteDb, publishSource, syncAndWait, waitFor } from './harness.js'

let conn = ''
const saude = async () => {
  const r = await as('admin').get('/api/v1/platform/health')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}
const ids = async () => (await saude()).problems.map((p: any) => p.id as string)

before(async () => { conn = await connectTestSource() })
after(shutdown)

describe('T-MON-08 / MON-14 o que precisa de atenção, numa tela', () => {
  let quebrado = { id: '', slug: '' }

  it('carga com erro aparece, com a mensagem, e sai quando a carga volta a funcionar', async () => {
    await fonteDb.query(`create table fonte.estoque as select g as id from generate_series(1, 5) g`)
    quebrado = await publishSource(conn, 'estoque', { syncMode: 'snapshot' })
    await syncAndWait(quebrado.id)
    await fonteDb.query('alter table fonte.estoque rename to estoque_old')
    await syncAndWait(quebrado.id).catch(() => { /* falha esperada */ })

    const h = await saude()
    const p = h.problems.find((x: any) => x.id === `sync-error:${quebrado.id}`)
    assert.ok(p, JSON.stringify(h.problems))
    assert.equal(p.severity, 'warn')
    assert.match(p.detail, /estoque/)
    assert.equal(p.link, `/datasets/${quebrado.slug}`)
    assert.ok(h.runs24h.error >= 1 && h.runs24h.failures.some((f: any) => f.slug === quebrado.slug),
      'a falha da noite aparece na lista de 24 h')

    await fonteDb.query('alter table fonte.estoque_old rename to estoque')
    await syncAndWait(quebrado.id)
    assert.ok(!(await ids()).includes(`sync-error:${quebrado.id}`), 'resolvido, saiu sozinho')
  })

  it('carga pausada aparece como crítica (e não duplicada como "falhou")', async () => {
    await fonteDb.query('alter table fonte.estoque rename to estoque_old')
    for (let i = 0; i < 3; i++) await syncAndWait(quebrado.id).catch(() => { /* falha esperada */ })
    const lista = await ids()
    assert.ok(lista.includes(`paused:${quebrado.id}`), JSON.stringify(lista))
    assert.ok(!lista.includes(`sync-error:${quebrado.id}`), 'o pausado não pode aparecer duas vezes')
    const p = (await saude()).problems.find((x: any) => x.id === `paused:${quebrado.id}`)
    assert.equal(p.severity, 'crit')
    assert.equal((await saude()).problems[0].severity, 'crit', 'os críticos vêm primeiro')
    await fonteDb.query('alter table fonte.estoque_old rename to estoque')
  })

  it('verificação contínua falhando e conciliação divergente entram na mesma lista', async () => {
    await fonteDb.query(`create table fonte.vendas as
      select g as id, timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em from generate_series(1, 10) g`)
    const ds = await publishSource(conn, 'vendas', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'], syncCadence: 'hourly',
    })
    await syncAndWait(ds.id)
    await fonteDb.query('delete from fonte.vendas where id = 4')
    const r = await as('admin').post(`/api/v1/quality/datasets/${ds.id}/reconcile`)
    assert.equal(r.status, 202)
    await waitFor(async () => (await db.query(
      `select 1 from reconcile_runs where dataset_id = $1 and status = 'diverged'`, [ds.id])).rowCount, 30_000)
    const { runStaleChecks } = await import('../modules/quality/checks.js')
    await db.query(`update datasets set last_sync_at = now() - interval '5 hours' where id = $1`, [ds.id])
    await runStaleChecks(new Date())

    const lista = await ids()
    assert.ok(lista.includes(`reconcile:${ds.id}`), JSON.stringify(lista))
    assert.ok(lista.includes(`check:stale:${ds.id}`), JSON.stringify(lista))
  })

  it('verificação de saúde (endpoint) fora do ar aparece', async () => {
    const t = (await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0].id
    await db.query(`insert into health_checks (tenant_id, name, url, interval_minutes, enabled, created_by)
                    values ($1, 'API de faturas', 'https://faturas.exemplo/health', 5, true, 'teste')`, [t])
    await db.query(`insert into api_call_metrics (endpoint, status, ok, duration_ms, check_type, error)
                    values ('https://faturas.exemplo/health', 503, false, 120, 'healthcheck', 'Service Unavailable')`)
    const p = (await saude()).problems.find((x: any) => x.title === 'API de faturas: fora do ar')
    assert.ok(p, 'endpoint fora não apareceu')
    assert.equal(p.severity, 'crit')
    assert.match(p.detail, /HTTP 503/)
  })

  it('a tela traz fila, motor e disco', async () => {
    const h = await saude()
    assert.equal(typeof h.queue.waiting, 'number')
    assert.ok(h.engine.maxNormal >= 1)
    assert.ok(h.disk && h.disk.totalBytes > 0, 'leitura do volume do lake')
  })
})

describe('O sino: aviso dentro do sistema', () => {
  it('conta os problemas e os alertas não vistos; marcar como visto zera o contador', async () => {
    const b = await as('admin').get('/api/v1/platform/badge')
    assert.equal(b.status, 200)
    assert.ok(b.body.problems >= 3 && b.body.crit >= 2, JSON.stringify(b.body))
    assert.ok(b.body.unseenAlerts >= 1, 'a pausa e a divergência viraram alertas no sistema')

    const ev = await as('admin').get('/api/v1/quality/alerts')
    const primeiro = ev.body.events[0]
    assert.equal(primeiro.seenAt, null)
    assert.equal(primeiro.status, 'no-channel', 'sem webhook, o aviso fica só no sistema')

    const um = await as('admin').post('/api/v1/quality/alerts/seen', { ids: [primeiro.id] })
    assert.equal(um.body.marked, 1)
    const todos = await as('admin').post('/api/v1/quality/alerts/seen', {})
    assert.ok(todos.body.marked >= 0)
    assert.equal((await as('admin').get('/api/v1/platform/badge')).body.unseenAlerts, 0)
    const depois = (await as('admin').get('/api/v1/quality/alerts')).body.events[0]
    assert.equal(depois.seenBy, as('admin').email, 'fica registrado quem viu')
  })

  it('só admin enxerga', async () => {
    for (const who of ['viewer', 'editor'] as const) {
      assert.equal((await as(who).get('/api/v1/platform/health')).status, 403, who)
      assert.equal((await as(who).get('/api/v1/platform/badge')).status, 403, who)
      assert.equal((await as(who).post('/api/v1/quality/alerts/seen', {})).status, 403, who)
    }
  })
})
