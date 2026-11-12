// ─────────────────────────────────────────────────────────────────────────
// Conciliação fonte × lake (D-QLD-3) e alertas (P-QLD-2), contra uma "fonte
// de produção" de laboratório: tabelas no schema `fonte` do Postgres de teste,
// lidas pelo MESMO caminho de ingestão das fontes de verdade.
//
// Os testes de qualidade (qualidade.test.ts) provam os defeitos olhando o lake
// de fora. Aqui a pergunta é outra: o SISTEMA percebe sozinho? Cada defeito
// silencioso conhecido é provocado e a conciliação tem de acusá-lo — com o dia
// certo, quando há chave de data — e o alerta tem de sair uma vez só.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { as, db, shutdown, connectTestSource, fonteDb, publishSource, syncAndWait, waitFor } from './harness.js'

let conn = ''
const tenantId = async () => String((await db.query(`select id from tenants where slug = 'sebratel'`)).rows[0].id)

/** "Conciliar agora" pela rota real e espera a conferência terminar. */
async function reconcileAndWait(datasetId: string): Promise<any> {
  const r = await as('admin').post(`/api/v1/quality/datasets/${datasetId}/reconcile`)
  assert.equal(r.status, 202, JSON.stringify(r.body))
  const fim = await waitFor(async () => {
    const h = await as('admin').get(`/api/v1/quality/datasets/${datasetId}/reconciliations`)
    const run = h.body.runs?.find((x: any) => x.id === r.body.id)
    return run && !['queued', 'running'].includes(run.status) ? run : null
  }, 30_000)
  assert.ok(fim, 'a conciliação não terminou em 30 s')
  return fim
}

// Webhook de mentira: guarda cada POST recebido.
const recebidos: { text: string }[] = []
let webhook: Server
let webhookUrl = ''

before(async () => {
  conn = await connectTestSource()
  webhook = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      let corpo = ''
      req.on('data', (c) => { corpo += c })
      req.on('end', () => { recebidos.push(JSON.parse(corpo)); res.writeHead(200).end('{}') })
    }).listen(0, '127.0.0.1', () => resolve(s))
  })
  webhookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`
})

after(async () => {
  await new Promise<void>((r) => webhook.close(() => r()))
  await shutdown()
})

describe('T-QLD-01/03 conciliação que bate', () => {
  it('snapshot: fonte e lake com as mesmas linhas e a mesma soma de controle', async () => {
    await fonteDb.query(`create table fonte.cadastro as
      select g as id, 'item ' || g as nome from generate_series(1, 137) g`)
    const ds = await publishSource(conn, 'cadastro', { syncMode: 'snapshot' })
    const run = await reconcileAndWait(ds.id)
    assert.equal(run.status, 'match', JSON.stringify(run))
    assert.equal(run.method, 'total')
    assert.equal(run.sourceRows, 137)
    assert.equal(run.lakeRows, 137)
    assert.equal(run.sumField?.key, 'id', 'a identidade numérica é a soma de controle')
    assert.equal(run.sourceSum, (137 * 138) / 2)
    assert.equal(run.lakeSum, run.sourceSum)
  })

  it('incremental por data: a carga antes da conferência traz o que entrou depois da última', async () => {
    await fonteDb.query(`create table fonte.pedidos_ok as
      select g as id, timestamp '2026-10-01 08:00:00' + (g || ' hours')::interval as criado_em
        from generate_series(1, 80) g`)
    const ds = await publishSource(conn, 'pedidos_ok', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    // Entra depois da carga: sem a carga ANTES da conferência, isto seria
    // acusado como perda — e não é defeito, é o próximo ciclo.
    await fonteDb.query(`insert into fonte.pedidos_ok values (81, timestamp '2026-10-05 08:00:00')`)
    const run = await reconcileAndWait(ds.id)
    assert.equal(run.status, 'match', JSON.stringify(run))
    assert.equal(run.method, 'per-day')
    assert.equal(run.sourceRows, 81)
    assert.ok(run.daysCompared >= 4, `${run.daysCompared} dia(s) comparados`)
    assert.deepEqual(run.diffDays, [])
  })
})

describe('Defeitos silenciosos que a conciliação acusa', () => {
  it('QLD-01: o empate na fronteira do lote aparece no dia certo', async () => {
    // 30 linhas com o MESMO carimbo cruzando o lote de 50: o keyset pula 20.
    await fonteDb.query(`create table fonte.faturas_empate as
      select g as id,
             case when g between 41 and 70 then timestamp '2026-09-30 23:00:00'
                  else timestamp '2026-09-01 00:00:00' + (g || ' minutes')::interval end as criado_em
        from generate_series(1, 120) g`)
    const ds = await publishSource(conn, 'faturas_empate', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    const run = await reconcileAndWait(ds.id)
    assert.equal(run.status, 'diverged', JSON.stringify(run))
    assert.equal(run.sourceRows, 120)
    assert.equal(run.lakeRows, 100)
    assert.deepEqual(run.diffDays.map((d: any) => [d.day, d.sourceRows, d.lakeRows]), [['2026-09-30', 30, 10]],
      'só o dia do empate diverge, com as 20 linhas que faltam')
  })

  it('QLD-06: registro apagado na fonte aparece como linha a mais no lake', async () => {
    await fonteDb.query(`create table fonte.clientes_del as
      select g as id, timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em from generate_series(1, 10) g`)
    const ds = await publishSource(conn, 'clientes_del', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    await fonteDb.query('delete from fonte.clientes_del where id = 3')
    const run = await reconcileAndWait(ds.id)
    assert.equal(run.status, 'diverged')
    assert.deepEqual([run.sourceRows, run.lakeRows], [9, 10])
    assert.equal(run.diffDays[0]?.day, '2026-10-01')
  })

  it('QLD-07: linha sem chave de criação nunca entra, e a conferência conta', async () => {
    await fonteDb.query(`create table fonte.sem_chave as
      select g as id, case when g <= 4 then null else timestamp '2026-10-02' + (g || ' minutes')::interval end as criado_em
        from generate_series(1, 20) g`)
    const ds = await publishSource(conn, 'sem_chave', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    const run = await reconcileAndWait(ds.id)
    assert.equal(run.status, 'diverged', 'os dias batem, mas 4 linhas nunca chegam')
    assert.equal(run.lostRows, 4)
    assert.deepEqual(run.diffDays, [])
  })

  it('cada divergência deixa um alerta registrado, mesmo sem canal cadastrado', async () => {
    const r = await as('admin').get('/api/v1/quality/alerts')
    assert.equal(r.status, 200)
    const titulos: string[] = r.body.events.map((e: any) => e.title)
    for (const nome of [/faturas empate/i, /clientes del/i, /sem chave/i]) {
      assert.ok(titulos.some((t) => /^Conciliação divergente: /.test(t) && nome.test(t)), `${nome}: ${JSON.stringify(titulos)}`)
    }
    assert.ok(r.body.events.every((e: any) => e.status === 'no-channel'), 'sem webhook, nada sai — mas fica registrado')
  })
})

describe('Quem pode o quê', () => {
  it('viewer e editor não conciliam nem leem os resultados', async () => {
    const ds = (await db.query(`select id from datasets where object_name = 'cadastro'`)).rows[0]
    for (const who of ['viewer', 'editor'] as const) {
      assert.equal((await as(who).post(`/api/v1/quality/datasets/${ds.id}/reconcile`)).status, 403, who)
      assert.equal((await as(who).get('/api/v1/quality/overview')).status, 403, who)
    }
  })

  it('conjunto calculado é recusado com o motivo', async () => {
    const r = await as('admin').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE calc conciliação', sql: 'select id from cadastro',
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const c = await as('admin').post(`/api/v1/quality/datasets/${r.body.id}/reconcile`)
    assert.equal(c.status, 400)
    assert.match(c.body.error, /calculado/i)
  })

  it('a visão geral lista as fontes com a última conferência e as faixas em vigor', async () => {
    const r = await as('admin').get('/api/v1/quality/overview')
    assert.equal(r.status, 200)
    const cad = r.body.datasets.find((d: any) => d.slug === 'cadastro')
    assert.equal(cad.lastRun.status, 'match')
    assert.equal(cad.band, 'small')
    assert.equal(cad.ineligible, null)
    assert.deepEqual(r.body.rules, { smallMaxRows: 100_000, largeMinRows: 2_000_000, largeWindowDays: 60, reconcileHour: 6 })
  })

  it('o canal de alertas é do master; o endereço nunca volta inteiro', async () => {
    const url = 'https://chat.googleapis.com/v1/spaces/TESTE/messages?key=SEGREDO&token=fim1'
    assert.equal((await as('admin').put('/api/v1/quality/alerts', { webhookUrl: url })).status, 403)
    assert.equal((await as('master').put('/api/v1/quality/alerts', { webhookUrl: 'http://chat.googleapis.com/x' })).status, 400,
      'http:// mandaria o segredo em claro')
    const ok = await as('master').put('/api/v1/quality/alerts', { webhookUrl: url })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const lido = await as('admin').get('/api/v1/quality/alerts')
    assert.equal(lido.body.settings.configured, true)
    assert.equal(lido.body.settings.hint, 'chat.googleapis.com …fim1')
    assert.ok(!JSON.stringify(lido.body).includes('SEGREDO'), 'a chave do webhook vazou na resposta')
    // Desligar mantém o endereço; vazio o remove.
    const off = await as('master').put('/api/v1/quality/alerts', { enabled: false })
    assert.deepEqual([off.body.settings.configured, off.body.settings.enabled], [true, false])
    const rm = await as('master').put('/api/v1/quality/alerts', { webhookUrl: '', enabled: true })
    assert.equal(rm.body.settings.configured, false)
  })
})

describe('P-QLD-2: a divergência chega ao canal, uma vez', () => {
  it('avisa ao divergir, não repete o mesmo assunto e avisa quando volta a bater', async () => {
    // O endereço do laboratório é http://127.0.0.1, que a rota recusa de
    // propósito: grava direto, cifrado, como a rota gravaria.
    const { encryptSecret } = await import('../core/crypto.js')
    await db.query(
      `insert into alert_settings (tenant_id, webhook_enc, webhook_hint, enabled) values ($1, $2, 'teste', true)
       on conflict (tenant_id) do update set webhook_enc = excluded.webhook_enc, enabled = true`,
      [await tenantId(), encryptSecret(webhookUrl)],
    )
    await fonteDb.query(`create table fonte.avisos as
      select g as id, timestamp '2026-10-03' + (g || ' minutes')::interval as criado_em from generate_series(1, 6) g`)
    const ds = await publishSource(conn, 'avisos', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    await fonteDb.query('delete from fonte.avisos where id = 2')

    const antes = recebidos.length
    assert.equal((await reconcileAndWait(ds.id)).status, 'diverged')
    const chegou = await waitFor(async () => recebidos.length > antes, 5_000)
    assert.ok(chegou, 'o alerta não chegou ao webhook')
    assert.match(recebidos[recebidos.length - 1].text, /Conciliação divergente: avisos/i)
    assert.match(recebidos[recebidos.length - 1].text, /03\/10\/2026/, 'o alerta diz o dia')

    // Mesmo assunto de novo: registrado, mas não reenviado.
    const depois = recebidos.length
    assert.equal((await reconcileAndWait(ds.id)).status, 'diverged')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(recebidos.length, depois, 'o mesmo alerta saiu duas vezes')

    // Conserta a fonte (o registro volta): a conferência bate e o canal sabe.
    await fonteDb.query(`insert into fonte.avisos values (2, timestamp '2026-10-03' + interval '2 minutes')`)
    assert.equal((await reconcileAndWait(ds.id)).status, 'match')
    const fechou = await waitFor(async () => recebidos.some((m) => /voltou a bater: avisos/i.test(m.text)), 5_000)
    assert.ok(fechou, 'o aviso de que voltou a bater não chegou')
  })

  it('a carga pausada por falhas seguidas também avisa (MON-03)', async () => {
    await fonteDb.query(`create table fonte.quebra as select g as id from generate_series(1, 3) g`)
    const ds = await publishSource(conn, 'quebra', { syncMode: 'snapshot' })
    await fonteDb.query('drop table fonte.quebra')
    for (let i = 0; i < 3; i++) await syncAndWait(ds.id).catch(() => { /* falha esperada */ })
    const chegou = await waitFor(async () => recebidos.some((m) => /Carga pausada: quebra/.test(m.text)), 5_000)
    assert.ok(chegou, 'a pausa automática não avisou ninguém')
  })
})

describe('Rotina diária (D-QLD-3)', () => {
  it('escolhe um por faixa, uma vez por dia', async () => {
    const { runDailyPick } = await import('../modules/quality/reconcile.js')
    const hoje = new Date()
    const escolhidos = await runDailyPick(hoje)
    // No laboratório todos os conjuntos são pequenos: um escolhido, o que está
    // há mais tempo sem conferência (nunca conferido vem primeiro).
    assert.equal(escolhidos.length, 1, JSON.stringify(escolhidos))
    assert.deepEqual(await runDailyPick(hoje), [], 'a mesma escolha não pode acontecer duas vezes no dia')
    // Espera a conferência escolhida terminar antes de desligar o banco.
    const fim = await waitFor(async () => (await db.query(
      `select 1 from reconcile_runs where trigger = 'daily' and status not in ('queued', 'running')`)).rowCount, 30_000)
    assert.ok(fim, 'a conciliação da rotina diária não terminou')
  })
})
