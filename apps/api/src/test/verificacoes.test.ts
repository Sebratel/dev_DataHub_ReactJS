// ─────────────────────────────────────────────────────────────────────────
// Verificações contínuas (D-QLD-2, opção A): o que o sistema confere sozinho
// depois de cada carga e a cada 15 min, sem tocar na fonte — e a identidade
// conferida na fonte pela conciliação (QLD-04).
//
// Mesmo laboratório do conciliacao.test.ts: tabelas no schema `fonte` do
// Postgres de teste, lidas pelo caminho de ingestão de verdade. Cada defeito
// é provocado e a verificação tem de acusá-lo, avisar UMA vez e avisar de
// novo quando ele some.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, publishSource, syncAndWait, waitFor } from './harness.js'

let conn = ''
const estado = async (datasetId: string, check: string) =>
  (await db.query(`select status, detail, since from dataset_checks where dataset_id = $1 and check_name = $2`,
    [datasetId, check])).rows[0] as { status: string; detail: string; since: Date } | undefined
// As verificações pós-carga rodam no gancho da fila, DEPOIS de a carga ser
// marcada como concluída — que é o que o syncAndWait espera. Então o estado
// é aguardado, não lido na hora. (A carga seguinte do mesmo processo só
// começa depois do gancho: a fila é uma cadeia só.)
const esperaEstado = async (datasetId: string, check: string, status: 'ok' | 'fail') =>
  (await waitFor(async () => {
    const e = await estado(datasetId, check)
    return e?.status === status ? e : null
  }, 10_000)) ?? await estado(datasetId, check)
const alertas = async (re: RegExp) =>
  (await db.query(`select title from alert_events order by created_at`)).rows.map((r) => String(r.title)).filter((t) => re.test(t))

before(async () => { conn = await connectTestSource() })
after(shutdown)

describe('QLD-08 volume do snapshot', () => {
  it('snapshot que encolhe de uma carga para a outra é acusado, e o normal volta a avisar', async () => {
    await db.query(`create table fonte.produtos as select g as id, 'p' || g as nome from generate_series(1, 1500) g`)
    const ds = await publishSource(conn, 'produtos', { syncMode: 'snapshot' })
    await syncAndWait(ds.id)
    assert.equal(await estado(ds.id, 'volume'), undefined, 'a primeira carga não tem com o que comparar')

    await db.query('delete from fonte.produtos where id > 1000') // −33%
    await syncAndWait(ds.id)
    const caiu = await esperaEstado(ds.id, 'volume', 'fail')
    assert.equal(caiu?.status, 'fail', JSON.stringify(caiu))
    assert.match(caiu!.detail, /1\.000 linhas; a anterior, 1\.500/)
    assert.equal((await alertas(/^Volume caiu: Produtos$/)).length, 1)

    // A régua é carga contra a anterior: de 1.000 para 1.000 não é queda, e o
    // estado volta ao normal (com um aviso só, logo abaixo).
    await syncAndWait(ds.id)
    assert.equal((await esperaEstado(ds.id, 'volume', 'ok'))?.status, 'ok', 'de 1.000 para 1.000 não é queda')
    await db.query(`insert into fonte.produtos select g, 'p' || g from generate_series(1001, 1500) g`)
    await syncAndWait(ds.id)
    assert.equal((await esperaEstado(ds.id, 'volume', 'ok'))?.status, 'ok')
    assert.equal((await alertas(/^Volume caiu: Produtos$/)).length, 1, 'o mesmo aviso saiu duas vezes')
    assert.equal((await alertas(/^Volume normal de novo: Produtos$/)).length, 1)
  })
})

describe('QLD-04 identidade', () => {
  it('identidade vazia no lake é acusada depois da carga', async () => {
    await db.query(`create table fonte.cupons as
      select g as id, case when g <= 3 then null else 'C' || g end as codigo,
             timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em
        from generate_series(1, 20) g`)
    const ds = await publishSource(conn, 'cupons', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['codigo'],
    })
    await syncAndWait(ds.id)
    const e = await esperaEstado(ds.id, 'identity', 'fail')
    assert.equal(e?.status, 'fail', JSON.stringify(e))
    assert.match(e!.detail, /identidade \(codigo\) vazia/)
  })

  it('identidade preenchida passa', async () => {
    await db.query(`create table fonte.notas as
      select g as id, timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em from generate_series(1, 30) g`)
    const ds = await publishSource(conn, 'notas', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    assert.equal((await esperaEstado(ds.id, 'identity', 'ok'))?.status, 'ok')
  })

  it('a conciliação acusa identidade que não é única na fonte (linhas diferentes viram uma no lake)', async () => {
    await db.query(`create table fonte.leituras_grupo as
      select g as id, (g % 5) as grupo, timestamp '2026-10-02' + (g || ' minutes')::interval as criado_em
        from generate_series(1, 20) g`)
    const ds = await publishSource(conn, 'leituras_grupo', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['grupo'],
    })
    const r = await as('admin').post(`/api/v1/quality/datasets/${ds.id}/reconcile`)
    assert.equal(r.status, 202, JSON.stringify(r.body))
    const run = await waitFor(async () => {
      const h = await as('admin').get(`/api/v1/quality/datasets/${ds.id}/reconciliations`)
      const x = h.body.runs?.[0]
      return x && !['queued', 'running'].includes(x.status) ? x : null
    }, 30_000)
    assert.equal(run.status, 'diverged', JSON.stringify(run))
    assert.equal(run.dupIdentity, 15, '20 linhas para 5 grupos: 15 somem na compactação')
    assert.deepEqual([run.sourceRows, run.lakeRows], [20, 5])
  })
})

describe('MON-09 / QLD-10 prazo pela cadência', () => {
  it('conjunto de hora em hora parado há 3 h fica atrasado, e volta quando carrega', async () => {
    const { runStaleChecks } = await import('../modules/quality/checks.js')
    await db.query(`create table fonte.chamados_h as
      select g as id, timestamp '2026-10-03' + (g || ' minutes')::interval as criado_em from generate_series(1, 5) g`)
    const ds = await publishSource(conn, 'chamados_h', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'], syncCadence: 'hourly',
    })
    await syncAndWait(ds.id)
    await db.query(`update datasets set last_sync_at = now() - interval '3 hours' where id = $1`, [ds.id])
    await runStaleChecks(new Date())
    const e = await estado(ds.id, 'stale')
    assert.equal(e?.status, 'fail', JSON.stringify(e))
    assert.match(e!.detail, /de hora em hora, o limite é 2 h/)

    const desde = e!.since
    await runStaleChecks(new Date())
    assert.deepEqual((await estado(ds.id, 'stale'))?.since, desde, 'reavaliar não reinicia o "desde quando"')
    assert.equal((await alertas(/^Conjunto atrasado: Chamados H$/)).length, 1, 'avaliar de novo não pode repetir o aviso')

    await syncAndWait(ds.id)
    await runStaleChecks(new Date())
    assert.equal((await estado(ds.id, 'stale'))?.status, 'ok')
    assert.equal((await alertas(/^Prazo em dia de novo: Chamados H$/)).length, 1)
  })

  it('calculado em cascata que não acompanha o insumo fica atrasado', async () => {
    const { runStaleChecks } = await import('../modules/quality/checks.js')
    const r = await as('admin').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE resumo notas', sql: 'select count(*) as n from notas', syncCadence: 'cascade',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    await waitFor(async () => (await db.query(
      `select last_sync_at from datasets where id = $1 and last_sync_at is not null`, [r.body.id])).rowCount, 15_000)
    // O insumo andou 2 h depois da última materialização do calculado.
    await db.query(`update datasets set last_sync_at = now() - interval '3 hours' where id = $1`, [r.body.id])
    await db.query(`update datasets set last_sync_at = now() - interval '1 hour' where slug = 'notas'`)
    await runStaleChecks(new Date())
    const e = await estado(String(r.body.id), 'stale')
    assert.equal(e?.status, 'fail', JSON.stringify(e))
    assert.match(e!.detail, /insumo notas atualizou 2 h/)
  })

  it('a visão geral lista o que está falhando agora, com o desde quando', async () => {
    const r = await as('admin').get('/api/v1/quality/overview')
    assert.equal(r.status, 200)
    const tipos = r.body.failingChecks.map((c: any) => `${c.check}:${c.slug}`)
    assert.ok(tipos.includes('identity:cupons'), JSON.stringify(tipos))
    assert.ok(tipos.some((t: string) => t.startsWith('stale:teste-comite-resumo-notas')), JSON.stringify(tipos))
    assert.ok(!tipos.includes('stale:chamados-h'), 'o que voltou ao normal não aparece')
    assert.ok(r.body.failingChecks.every((c: any) => c.status === 'fail' && c.since))
  })
})
