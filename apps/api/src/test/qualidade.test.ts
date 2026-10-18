// ─────────────────────────────────────────────────────────────────────────
// Testes de QUALIDADE DOS DADOS do plano do comitê (DATAHUB v0.1, §10.4 e
// §5.5). A "fonte de produção" aqui é o próprio Postgres de teste: tabelas no
// schema `fonte`, lidas pelo MESMO caminho de ingestão das fontes de verdade
// (conexão cadastrada pela tela, conjunto publicado, regra de carga aplicada
// pelo master, fila de sincronização) — e o lake é conferido contra a fonte.
//
// É a reconciliação fonte × lake (T-QLD-01/02, QLD-02) feita em laboratório,
// onde dá para PROVOCAR os riscos silenciosos que em produção só aparecem
// quando alguém estranha um número: linha perdida no keyset (QLD-01),
// duplicada pela folga (QLD-03), histórico cortado na recarga (QLD-05) e
// exclusão que não chega (QLD-06). Fraqueza aberta = `todo` com o ID dela.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, publishSource, syncAndWait, lakeCount, lakeRows } from './harness.js'

let conn = ''
const fonteCount = async (t: string) => Number((await db.query(`select count(*) n from fonte.${t}`)).rows[0].n)

before(async () => {
  conn = await connectTestSource()
})

after(shutdown)

describe('T-QLD-01 reconciliar contagem', () => {
  it('T-QLD-01 snapshot: o lake tem exatamente as linhas da fonte, em várias páginas', async () => {
    await db.query(`create table fonte.contratos as
      select g as id, 'cliente ' || g as cliente, (g * 10)::numeric(12,2) as valor
        from generate_series(1, 137) g`)
    const ds = await publishSource(conn, 'contratos', { syncMode: 'snapshot' })
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), await fonteCount('contratos'))
    // Soma ao centavo (T-QLD-03 em miniatura): o valor não muda no caminho.
    const lakeSoma = (await lakeRows(ds.slug)).reduce((s, r) => s + Number(r.valor), 0)
    const fonteSoma = Number((await db.query('select sum(valor) s from fonte.contratos')).rows[0].s)
    assert.equal(lakeSoma.toFixed(2), fonteSoma.toFixed(2))
  })

  it('T-QLD-01 a consulta da tela conta o mesmo que a fonte', async () => {
    const r = await as('admin').post('/api/v1/datasets/contratos/query', { select: [{ agg: 'count', as: 'n' }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(Number(r.body.rows[0].n), 137)
  })
})

describe('QLD-01 keyset com chave repetida na fronteira do lote', () => {
  it('QLD-01 incremental: 30 linhas com o MESMO carimbo cruzando o lote de 50 não se perdem', {
    todo: 'QLD-01: o keyset ("chave > último valor") pula as linhas restantes do carimbo repetido — 120 viram 100, sem erro.',
  }, async () => {
    // Linhas 41..70 com o mesmo criado_em: o lote 1 (50 linhas) termina no
    // meio delas, o watermark vira esse carimbo, e o lote 2 pede "> carimbo".
    await db.query(`create table fonte.faturas as
      select g as id,
             case when g between 41 and 70 then timestamp '2026-09-30 23:00:00'
                  else timestamp '2026-09-01 00:00:00' + (g || ' minutes')::interval end as criado_em,
             (g * 1.5)::numeric(12,2) as valor
        from generate_series(1, 120) g`)
    const ds = await publishSource(conn, 'faturas', { syncMode: 'incremental', incrementalKey: 'criado_em' })
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), 120, 'linhas perdidas na fronteira do lote')
  })
})

describe('T-QLD-05 edição chega sem duplicar', () => {
  it('T-QLD-05 duas chaves + identidade: a linha editada aparece uma vez, com o valor novo', async () => {
    await db.query(`create table fonte.pedidos as
      select g as id, timestamp '2026-10-01 08:00:00' + (g || ' minutes')::interval as criado_em,
             timestamp '2026-10-01 08:00:00' + (g || ' minutes')::interval as modificado_em,
             'aberto' as status
        from generate_series(1, 20) g`)
    const ds = await publishSource(conn, 'pedidos', {
      syncMode: 'incremental', incrementalKey: 'criado_em', incrementalKey2: 'modificado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), 20)

    await db.query(`update fonte.pedidos set status = 'faturado', modificado_em = timestamp '2026-10-02 10:00:00' where id = 7`)
    await syncAndWait(ds.id)
    const linhas = (await lakeRows(ds.slug)).filter((r) => Number(r.id) === 7)
    assert.equal(linhas.length, 1, 'a linha editada entrou duplicada')
    assert.equal(linhas[0].status, 'faturado', 'a edição não chegou ao lake')
    assert.equal(await lakeCount(ds.slug), 20)
  })
})

describe('QLD-03 folga de reconferência sem identidade', () => {
  it('QLD-03 duas cargas com folga e sem identidade não duplicam linhas', {
    todo: 'QLD-03: a folga relê a janela e, sem identidade, cada execução reinsere as mesmas linhas.',
  }, async () => {
    await db.query(`create table fonte.chamados as
      select g as id, now()::timestamp - (g || ' seconds')::interval as criado_em, 'novo' as status
        from generate_series(1, 10) g`)
    const ds = await publishSource(conn, 'chamados', {
      syncMode: 'incremental', incrementalKey: 'criado_em', watermarkLagMinutes: 60,
    })
    await syncAndWait(ds.id)
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), await fonteCount('chamados'), 'linhas duplicadas pela folga')
  })
})

describe('QLD-06 exclusão na fonte', () => {
  it('QLD-06 registro apagado na fonte some do lake', {
    todo: 'QLD-06: o incremental só lê o novo/editado; o apagado continua no lake e infla contagens.',
  }, async () => {
    await db.query(`create table fonte.clientes as
      select g as id, timestamp '2026-10-01' + (g || ' minutes')::interval as criado_em from generate_series(1, 10) g`)
    const ds = await publishSource(conn, 'clientes', {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'],
    })
    await syncAndWait(ds.id)
    await db.query('delete from fonte.clientes where id = 3')
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), 9)
  })
})

describe('QLD-05 recarga com piso', () => {
  it('QLD-05 "Recarregar tudo" num conjunto com piso não corta o histórico já acumulado', {
    todo: 'QLD-05: a recarga zera o watermark mas respeita o piso — 60 dias acumulados viram 30, e a tela diz "lido inteiro".',
  }, async () => {
    // 60 dias de histórico, todos lidos enquanto ainda não havia piso…
    await db.query(`create table fonte.leituras as
      select g as id, (now() - (g || ' days')::interval)::timestamp as criado_em from generate_series(1, 60) g`)
    const ds = await publishSource(conn, 'leituras', { syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'] })
    await syncAndWait(ds.id)
    assert.equal(await lakeCount(ds.slug), 60)
    // …depois alguém põe "últimos 30 dias" e recarrega.
    const cfg = await as('master').patch(`/api/v1/datasets/${ds.id}/sync-config`, {
      syncMode: 'incremental', incrementalKey: 'criado_em', dedupeKeys: ['id'], syncSinceDays: 30,
    })
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body))
    await syncAndWait(ds.id, 'reload')
    assert.equal(await lakeCount(ds.slug), 60, 'histórico anterior ao piso foi apagado pela recarga')
  })
})

describe('T-QLD-07 fuso horário (regressão)', () => {
  it('T-QLD-07 coluna com fuso guarda a hora LOCAL da fonte no lake', async () => {
    await db.query(`create table fonte.eventos (id int, ocorrido_em timestamptz, registrado_em timestamp)`)
    await db.query(`insert into fonte.eventos values
      (1, '2026-10-01 15:10:00-03', '2026-10-01 15:10:00'),
      (2, '2026-10-01 23:59:59-03', '2026-10-01 23:59:59')`)
    const ds = await publishSource(conn, 'eventos', { syncMode: 'snapshot' })
    await syncAndWait(ds.id)
    const r = await as('admin').post(`/api/v1/datasets/${ds.slug}/query`, {
      select: ['id', 'ocorrido_em', 'registrado_em'], orderBy: [{ field: 'id', dir: 'asc' }],
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const hora = (v: unknown) => String(v).replace('T', ' ').slice(0, 19)
    assert.equal(hora(r.body.rows[0].registrado_em), '2026-10-01 15:10:00', 'sem fuso: 3 h adiantado?')
    assert.equal(hora(r.body.rows[0].ocorrido_em), '2026-10-01 15:10:00', 'com fuso: virou UTC?')
    assert.equal(hora(r.body.rows[1].ocorrido_em), '2026-10-01 23:59:59', 'virada de dia em UTC')
  })
})
