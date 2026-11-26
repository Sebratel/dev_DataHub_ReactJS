// ─────────────────────────────────────────────────────────────────────────
// Pacotes de conjuntos (onda 1, 19/11/2026).
//
// Um "Voalle" de laboratório: o schema `erp` no banco de teste, com as
// colunas que o pacote lê e poucas linhas escolhidas a dedo (instalado,
// cancelado por inadimplência, venda que nunca instalou, lote, cortesia,
// telefonia, apagado, fatura com componente, tarifa de baixa…). Instala o
// pacote pela rota, deixa a fila carregar as fontes e a cascata materializar
// TODOS os calculados — o SQL de cada um roda de verdade no DuckDB, sobre o
// Parquet que a carga escreveu — e confere os números que as regras fixam.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, fonteDb, waitFor, waitQueueIdle, lakeRows, USERS } from './harness.js'
import { ONDA_1 } from '../modules/catalog/packs/onda1.js'

let conn = ''

before(async () => {
  conn = await connectTestSource()
  const q = (sql: string) => fonteDb.query(sql)
  await q('create schema if not exists erp')
  await q(`create table erp.contract_types (id bigint, title varchar)`)
  await q(`insert into erp.contract_types values (3, 'Sebratel - Cortesia'), (17, 'Sebratel - Contrato PJ'),
           (19, 'Sebratel - Contrato Telefonia'), (21, 'Sebratel - Contrato PF')`)
  await q(`create table erp.contract_event_types (id bigint, code varchar, title varchar)`)
  await q(`insert into erp.contract_event_types values
           (1, 'IND.CAN.001', 'Cancelamento - Inadimplência'),
           (2, 'FNC.CAN.020', 'Cancelamento de Contratos em Lote (VENDA OPERAÇÃO)'),
           (3, 'OTR.CAN.015', 'Cancelamento - Cliente Não Instalado - Falta de Contato'),
           (4, 'MDE.CAN.008', 'Cancelamento - Mudança de Endereço'),
           (9, 'OTR.OUT.001', 'Alteração de vencimento')`)
  await q(`create table erp.people (id bigint, type_tx_id bigint, city varchar, neighborhood varchar, state varchar, deleted boolean, name varchar)`)
  await q(`insert into erp.people values (1, 2, 'São Leopoldo', 'Centro', 'RS', false, 'NÃO PODE IR PARA O LAKE'),
           (2, 2, 'Canoas', 'Niterói', 'RS', false, 'x'), (3, 1, 'Esteio', 'Centro', 'RS', false, 'x')`)
  await q(`create table erp.people_addresses (id bigint, city varchar, neighborhood varchar, state varchar, deleted boolean, street varchar)`)
  await q(`insert into erp.people_addresses values (1, 'Novo Hamburgo', 'Rondônia', 'RS', false, 'Rua X')`)
  await q(`create table erp.contracts (id bigint, contract_number varchar, client_id bigint, contract_type_id bigint,
           status bigint, stage bigint, created timestamp, approval_date date, cancellation_date date, amount numeric,
           people_address_id bigint, deleted boolean, modified timestamp, observation text)`)
  await q(`insert into erp.contracts values
    (1, 'C-1', 1, 21, 1, 3, '2024-01-05', '2024-01-10', null,         100, 1,    false, now(), null),
    (2, 'C-2', 1, 21, 4, 3, '2024-03-01', '2024-03-05', '2026-10-15', 120, null, false, now(), null),
    (3, 'C-3', 3, 17, 1, 3, '2025-05-28', '2025-06-01', null,         300, null, false, now(), null),
    (4, 'C-4', 2,  3, 1, 3, '2023-05-01', '2023-05-01', null,          99, null, false, now(), null),
    (5, 'C-5', 2, 19, 1, 3, '2023-05-01', '2023-05-01', null,          50, null, false, now(), null),
    (6, 'C-6', 2, 21, 4, 5, '2026-10-01', null,         '2026-10-05',  90, null, false, now(), null),
    (7, 'C-7', 3, 21, 4, 3, '2023-02-01', '2023-02-01', '2026-06-10', 110, null, false, now(), null),
    (8, 'C-8', 3, 21, 1, 3, '2023-02-01', '2023-02-01', null,         999, null, true,  now(), null),
    (9, 'C-9', 2, 21, 1, 3, '1000-01-01', '2023-03-01', null,          80, null, false, now(), null)`)
  await q(`create table erp.contract_events (id bigint, contract_id bigint, contract_event_type_id bigint, date timestamp, deleted boolean, modified timestamp)`)
  await q(`insert into erp.contract_events values
    (1, 2, 9, '2026-01-01', false, now()), (2, 2, 1, '2026-10-15', false, now()),
    (3, 6, 3, '2026-10-05', false, now()), (4, 7, 2, '2026-06-10', false, now())`)
  await q(`create table erp.financers_natures (id bigint, title varchar)`)
  await q(`insert into erp.financers_natures values (59, 'RS - RECEITAS SERVIÇOS COMUNICAÇÃO SCM'), (77, 'DF - TARIFA BAIXA DE TÍTULO')`)
  await q(`create table erp.payment_forms (id bigint, title varchar)`)
  await q(`insert into erp.payment_forms values (10, 'Pix'), (7, 'Boleto')`)
  await q(`create table erp.financial_receivable_titles (id bigint, contract_id bigint, client_id bigint, bill_title_id bigint,
           financer_nature_id bigint, title_amount numeric, balance numeric, issue_date date, expiration_date date,
           competence date, renegotiated boolean, deleted boolean, modified timestamp)`)
  await q(`insert into erp.financial_receivable_titles values
    (100, 1, 1, null, 59, 100, 0,   '2026-09-01', '2026-09-10', '2026-09-01', false, false, now()),
    (101, 1, 1, 100,  59, 100, 0,   '2026-09-01', '2026-09-10', '2026-09-01', false, false, now()),
    (102, 1, 1, null, 59, 100, 0,   '2026-10-01', '2026-10-10', '2026-10-01', false, false, now()),
    (103, 2, 1, null, 59, 120, 120, '2026-09-01', '2026-09-10', '2026-09-01', false, false, now()),
    (104, 3, 3, null, 59, 300, 300, '2026-10-01', '2026-10-10', '2026-10-01', true,  false, now()),
    (105, 3, 3, null, 77, 300, 0,   '2026-09-01', '2026-09-10', '2026-09-01', false, false, now()),
    (106, 1, 1, null, 59, 100, 100, current_date, current_date + 60, current_date, false, false, now())`)
  await q(`create table erp.financial_receipt_titles (id bigint, financial_receivable_title_id bigint, receipt_date date,
           client_paid_date date, amount numeric, payment_form_id bigint, deleted boolean, modified timestamp)`)
  await q(`insert into erp.financial_receipt_titles values
    (1, 100, '2026-09-08', '2026-09-08', 100, 10, false, now()),
    (2, 101, '2026-09-08', '2026-09-08', 100, 10, false, now()),
    (3, 102, '2026-10-20', '2026-10-20', 100, 7,  false, now())`)
  // Como no Voalle: `modified` vazio em boa parte das linhas (58% das baixas desde
  // 2023). Estas três só entram pela passada de `created`, e os testes abaixo
  // contam com elas: o motivo "Inadimplência" do contrato 2, a fatura 103 em
  // atraso e a baixa por boleto de outubro.
  for (const t of ['contract_events', 'financial_receivable_titles', 'financial_receipt_titles']) {
    await q(`alter table erp.${t} add column created timestamp`)
    await q(`update erp.${t} set created = now()`)
  }
  await q(`update erp.contract_events set modified = null where id = 2`)
  await q(`update erp.financial_receivable_titles set modified = null where id = 103`)
  await q(`update erp.financial_receipt_titles set modified = null where id = 3`)
})
after(shutdown)

const slugsDoPacote = ONDA_1.datasets.map((d) => d.slug)
const slugsDosNotebooks = (ONDA_1.notebooks ?? []).map((n) => n.slug)
const linhas = async (slug: string) => lakeRows(slug)

describe('Pacotes de conjuntos: onda 1', () => {
  it('só o master instala; o admin vê a lista', async () => {
    const l = await as('admin').get('/api/v1/packs')
    assert.equal(l.status, 200, JSON.stringify(l.body))
    assert.equal(l.body.packs[0].id, 'onda-1')
    assert.ok(l.body.packs[0].datasets.every((d: { instalado: boolean }) => !d.instalado))
    assert.equal((await as('admin').post('/api/v1/packs/onda-1/install', { connectionId: conn })).status, 403)
    assert.equal((await as('editor').get('/api/v1/packs')).status, 403)
  })

  it('instala: fontes bronze só com as colunas usadas e todos os calculados materializam', async () => {
    const r = await as('master').post('/api/v1/packs/onda-1/install', { connectionId: conn })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const rep = r.body.report
    assert.deepEqual(rep.sources.filter((s: { status: string }) => s.status !== 'criada'), [], JSON.stringify(rep.sources))
    assert.deepEqual(rep.datasets.filter((d: { status: string }) => d.status !== 'criado'), [], JSON.stringify(rep.datasets))
    assert.deepEqual(rep.notebooks.filter((n: { status: string }) => n.status !== 'criado'), [], JSON.stringify(rep.notebooks))

    // Notebooks nascem privados, no nome de quem instalou, como os conjuntos.
    const nbs = (await db.query(`select slug, visibility, owner_email from notebooks where slug = any($1)`, [slugsDosNotebooks])).rows
    assert.equal(nbs.length, slugsDosNotebooks.length)
    assert.ok(nbs.every((n) => n.visibility === 'private' && n.owner_email === USERS.master), JSON.stringify(nbs))

    // A cópia bronze é fiel ao banco (nome da tabela, técnico e de exibição) e
    // não traz coluna que o pacote não usa.
    const bronze = (await db.query(`select id, slug, name from datasets where object_name = 'people' and kind = 'source'`)).rows[0]
    assert.equal(bronze.slug, 'people')
    assert.equal(bronze.name, 'people')
    const colunas = (await db.query('select source_column from dataset_fields where dataset_id = $1', [bronze.id])).rows.map((x) => x.source_column)
    assert.ok(!colunas.includes('name'), 'o nome da pessoa foi para o lake')

    // A fila carrega as fontes; a cascata materializa os calculados (e os que
    // dependem de calculados). Nenhum pode ficar sem carga nem com erro.
    const prontos = await waitFor(async () => {
      const r2 = (await db.query(
        `select slug, last_sync_at from datasets where kind = 'derived' and slug = any($1)`, [slugsDoPacote])).rows
      return r2.length === slugsDoPacote.length && r2.every((x) => x.last_sync_at) ? r2 : null
    }, 120_000)

    // A cascata procura os dependentes quando a carga termina. Fonte que começa
    // a carregar antes de o último calculado ser gravado pode terminar sem achá-lo,
    // e ele nunca roda. Só aparecia com a máquina carregada (CI de 20/11); esta
    // ordem é o que impede, e falha sempre contra a versão que enfileirava antes.
    const ordem = (await db.query(
      `select (select min(s.started_at) from sync_runs s join datasets f on f.id = s.dataset_id
                where f.kind = 'source' and f.schema_name = 'erp') as primeira_carga,
              (select max(d.created_at) from datasets d
                where d.kind = 'derived' and d.slug = any($1)) as ultimo_calculado`, [slugsDoPacote])).rows[0]
    assert.ok(ordem.primeira_carga && ordem.ultimo_calculado, JSON.stringify(ordem))
    assert.ok(new Date(ordem.primeira_carga).getTime() >= new Date(ordem.ultimo_calculado).getTime(),
      `uma fonte começou a carregar (${new Date(ordem.primeira_carga).toISOString()}) antes de o último calculado existir (${new Date(ordem.ultimo_calculado).toISOString()})`)

    const faltam = prontos ? [] : (await db.query(
      `select d.slug, (select error from sync_runs s where s.dataset_id = d.id order by started_at desc limit 1) as erro
         from datasets d where d.kind = 'derived' and d.slug = any($1) and d.last_sync_at is null`, [slugsDoPacote])).rows
    assert.ok(prontos, `não materializaram: ${JSON.stringify(faltam)}`)
    // Materializar uma vez não basta: a cascata pode refazer um calculado
    // enquanto o próximo teste lê o Parquet dele (ver waitQueueIdle).
    assert.ok(await waitQueueIdle(), 'a fila de cargas não parou')
  })

  it('os números seguem as regras do pacote', async () => {
    // Contrato: sem telefonia nem apagado; cortesia com valor zero; data "nula" do Voalle vira vazio.
    const contratos = await linhas('prata_voalle_contratos')
    assert.deepEqual(contratos.map((c) => Number(c.contrato_id)).sort((a, b) => a - b), [1, 2, 3, 4, 6, 7, 9])
    const porId = new Map(contratos.map((c) => [Number(c.contrato_id), c]))
    assert.equal(Number(porId.get(4)!.valor_mensal), 0, 'cortesia com receita')
    assert.equal(porId.get(9)!.vendido_em, null, '1000-01-01 virou data')
    assert.equal(porId.get(2)!.motivo_grupo, 'Inadimplência')
    assert.equal(porId.get(6)!.motivo_grupo, 'Não instalado')
    assert.equal(porId.get(7)!.motivo_grupo, 'Venda de operação (lote)')
    assert.equal(porId.get(1)!.cidade, 'Novo Hamburgo', 'o endereço de instalação vence o do cadastro')
    assert.equal(porId.get(3)!.pessoa, 'PJ')

    // Base de hoje: 1, 3, 4 e 9.
    const base = (await linhas('ouro_base_ativa_mensal')).sort((a, b) => String(b.mes).localeCompare(String(a.mes)))
    assert.equal(Number(base[0].contratos_ativos), 4)
    assert.equal(Number(base[0].receita_contratada), 480)

    // Outubro: 1 churn (o 2); a venda do 6 cancelou antes de instalar. Junho: só o lote.
    const canc = new Map((await linhas('ouro_cancelamento_mensal')).map((m) => [String(m.mes).slice(0, 7), m]))
    assert.equal(Number(canc.get('2026-10')!.cancelamentos), 1)
    assert.equal(Number(canc.get('2026-10')!.canceladas_antes_de_instalar), 1)
    assert.equal(Number(canc.get('2026-06')!.cancelamentos), 0)
    assert.equal(Number(canc.get('2026-06')!.cancelamentos_em_lote), 1)

    // Fatura: componente e tarifa de baixa ficam de fora; renegociada não é atraso.
    const faturas = await linhas('prata_voalle_faturas')
    assert.deepEqual(faturas.map((f) => Number(f.fatura_id)).sort((a, b) => a - b), [100, 102, 103, 104, 106])
    const fat = new Map((await linhas('ouro_financeiro_faturamento_mensal')).map((m) => [String(m.mes_vencimento).slice(0, 7), m]))
    assert.equal(Number(fat.get('2026-09')!.valor_faturado), 220)
    const atraso = await linhas('ouro_financeiro_contratos_em_atraso')
    assert.deepEqual(atraso.map((a) => Number(a.contrato_id)), [2], 'só o contrato 2 tem fatura vencida em aberto')
    const formas = await linhas('ouro_financeiro_recebimento_por_forma')
    assert.deepEqual(formas.map((f) => `${String(f.mes_pagamento).slice(0, 7)} ${f.forma_pagamento} ${Number(f.valor_recebido)}`).sort(),
      ['2026-09 Pix 100', '2026-10 Boleto 100'], 'a baixa do componente entrou em dobro')
  })

  it('as células SQL dos notebooks rodam pela rota de notebook e cabem no limite do Python', async () => {
    // A rota passa o SQL pela guarda do lake (palavras proibidas, funções de
    // tabela) e pela compilação com os conjuntos do catálogo. O Python não roda
    // aqui (é Pyodide, no navegador): foi validado com dado real (RUNBOOK).
    for (const nb of ONDA_1.notebooks ?? []) {
      nb.cells.forEach((c, i) => assert.notEqual(c.source.trim(), '', `${nb.slug}: célula ${i + 1} vazia`))
      for (const [i, c] of nb.cells.entries()) {
        if (c.kind !== 'sql') continue
        const r = await as('master').post('/api/v1/notebooks/run', { sql: c.source, limit: 500, notebook: nb.slug })
        assert.equal(r.status, 200, `${nb.slug}, célula ${i + 1}: ${JSON.stringify(r.body)}`)
        assert.equal(r.body.truncated, false, `${nb.slug}, célula ${i + 1}: passou de 500 linhas`)
      }
    }
  })

  it('instalar de novo não duplica nada', async () => {
    const r = await as('master').post('/api/v1/packs/onda-1/install', { connectionId: conn })
    assert.equal(r.status, 200)
    assert.ok(r.body.report.sources.every((s: { status: string }) => s.status === 'reaproveitada'))
    assert.ok(r.body.report.datasets.every((d: { status: string }) => d.status === 'ja-existe'))
    assert.ok(r.body.report.notebooks.every((n: { status: string }) => n.status === 'ja-existe'))
    assert.equal((await db.query(`select count(*) as n from notebooks where slug = any($1)`, [slugsDosNotebooks])).rows[0].n * 1,
      slugsDosNotebooks.length)
    const l = await as('admin').get('/api/v1/packs')
    assert.ok(l.body.packs[0].datasets.every((d: { instalado: boolean }) => d.instalado))
    assert.ok(l.body.packs[0].notebooks.every((n: { instalado: boolean }) => n.instalado))
  })
})
