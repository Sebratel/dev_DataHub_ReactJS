// ─────────────────────────────────────────────────────────────────────────
// Pacote "Onda 2" (campo: instalação, manutenção e agenda), 20/11/2026.
//
// Um Voalle de laboratório com protocolos escolhidos a dedo, um para cada
// regra que os painéis de Instalação e de Manutenção já validaram com a
// operação. Lista dos casos:
//   • instalação: ativação instalada (material alocado), ativação cancelada,
//     ativação ainda na fila e movimentação;
//   • retrabalho: retorno por problema no mesmo serviço em até 30 dias;
//   • manutenção: universo por equipe/catálogo, sem CGR e sem o registro
//     inicial do Suporte; preventivo, requisição, cancelado e apagado;
//   • recorrência: outro reparo no mesmo serviço em 30 dias;
//   • agenda: ocupação por região e tempos de deslocamento/execução.
// Instala SÓ a onda 2 (contratos e pessoas nascem com as colunas da onda 1).
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { as, db, shutdown, connectTestSource, fonteDb, waitFor, lakeRows } from './harness.js'
import { ONDA_2 } from '../modules/catalog/packs/onda2.js'
import { ONDA_1 } from '../modules/catalog/packs/onda1.js'

let conn = ''

before(async () => {
  conn = await connectTestSource()
  const q = (sql: string) => fonteDb.query(sql)
  await q('create schema if not exists erp')
  // Base de contratos: 1 ativo desde 2024; 2 instalado em 2025 e cancelado; 3 instalado em jan/2026;
  // 4 nunca instalado; 5 telefonia (fora).
  await q(`create table erp.contracts (id bigint, contract_number varchar, client_id bigint, contract_type_id bigint,
           status bigint, stage bigint, created timestamp, approval_date date, cancellation_date date, amount numeric,
           people_address_id bigint, deleted boolean, modified timestamp)`)
  await q(`insert into erp.contracts values
    (1, 'C-1', 1, 21, 1, 3, '2024-05-25', '2024-06-01', null,         100, null, false, now()),
    (2, 'C-2', 2, 21, 4, 3, '2025-03-05', '2025-03-10', '2025-08-01', 100, null, false, now()),
    (3, 'C-3', 1, 21, 1, 3, '2026-01-01', '2026-01-05', null,         100, null, false, now()),
    (4, 'C-4', 2, 21, 4, 5, '2026-02-01', null,         '2026-02-10', 100, null, false, now()),
    (5, 'C-5', 2, 19, 1, 3, '2024-01-01', '2024-01-02', null,          50, null, false, now())`)
  await q(`create table erp.people (id bigint, type_tx_id bigint, city varchar, neighborhood varchar, state varchar, deleted boolean, name varchar)`)
  await q(`insert into erp.people values (1, 2, 'Canoas', 'Centro', 'RS', false, 'NÃO PODE IR'), (2, 2, 'Esteio', 'Centro', 'RS', false, 'x')`)
  await q(`create table erp.incident_types (id bigint, code varchar, title varchar)`)
  await q(`insert into erp.incident_types values
    (12, 'A', 'Ativação fibra'), (268, 'B', 'Troca de endereço'),
    (1267, 'C', 'TEC-MANUT-ACESSO-CLI-INCIDENTE/PROBLEMA'),
    (500, 'D', 'TEC-MANUT-ACESSO-CLI-PREVENCAO/PROBLEMA'),
    (501, 'E', 'GERAL - Registro de Atendimento Inicial'),
    (502, 'F', 'TEC-MANUT-ACESSO-CLI-REQUISICAO'),
    (900, 'G', 'Comercial - outro')`)
  await q(`create table erp.incident_status (id bigint, title varchar)`)
  await q(`insert into erp.incident_status values (1, 'Abertura'), (2, 'Encerrado'), (3, 'Cancelado')`)
  await q(`create table erp.teams (id bigint, title varchar)`)
  await q(`insert into erp.teams values (65, 'Equipe de Reparo'), (1007, 'CGR - Central de Gestão de Rede'), (10, 'Equipe Ativação')`)
  await q(`create table erp.catalog_services (id bigint, title varchar)`)
  await q(`insert into erp.catalog_services values (1, 'Oper. Reparo'), (2, 'Equipe ativação')`)
  await q(`create table erp.contract_service_tags (id bigint, contract_id bigint, created timestamp, modified timestamp, street varchar)`)
  await q(`insert into erp.contract_service_tags values (1001, 3, now(), null, 'Rua X'), (1002, 1, now(), now(), 'Rua Y')`)
  await q(`create table erp.assignments (id bigint, assignment_type varchar, requestor_id bigint, created timestamp,
           conclusion_date timestamp, final_date timestamp, modified timestamp, deleted boolean, title varchar)`)
  await q(`insert into erp.assignments values
    (101, 'INC', 1, '2026-03-02 08:00', '2026-03-03 10:00', '2026-03-03 10:00', null,  false, 'segredo'),
    (102, 'INC', 1, '2026-03-05 09:00', '2026-03-06 09:00', '2026-03-06 09:00', now(), false, 'x'),
    (103, 'INC', 2, now() - interval '5 days', null, null, now(), false, 'x'),
    (104, 'INC', 1, '2026-03-10 09:00', '2026-03-12 18:00', '2026-03-12 18:00', now(), false, 'x'),
    (105, 'INC', 1, '2026-03-20 08:00', '2026-03-21 14:00', '2026-03-21 14:00', now(), false, 'x'),
    (106, 'INC', 1, '2026-04-05 08:00', '2026-04-05 18:00', '2026-04-05 18:00', now(), false, 'x'),
    (107, 'INC', 1, '2026-04-05 09:00', '2026-04-07 09:00', '2026-04-07 09:00', now(), false, 'x'),
    (108, 'INC', 1, '2026-04-05 10:00', '2026-04-05 10:05', '2026-04-05 10:05', now(), false, 'x'),
    (109, 'INC', 1, '2026-04-06 08:00', '2026-04-06 13:00', '2026-04-06 13:00', now(), false, 'x'),
    (110, 'INC', 1, '2026-04-07 08:00', '2026-04-07 09:00', '2026-04-07 09:00', now(), false, 'x'),
    (111, 'INC', 2, now() - interval '36 hours', null, null, now(), false, 'x'),
    (112, 'INC', 1, '2026-04-10 08:00', '2026-04-10 10:00', '2026-04-10 10:00', now(), false, 'x'),
    (113, 'INC', 1, '2026-04-11 08:00', '2026-04-11 10:00', '2026-04-11 10:00', now(), true,  'x')`)
  await q(`create table erp.assignment_incidents (assignment_id bigint, protocol bigint, incident_type_id bigint,
           incident_status_id bigint, team_id bigint, catalog_service_id bigint, contract_service_tag_id bigint, client_id bigint)`)
  await q(`insert into erp.assignment_incidents values
    (101, 9101, 12,   2, 10,   2, 1001, 1),
    (102, 9102, 12,   3, 10,   2, null, 1),
    (103, 9103, 12,   1, 10,   2, null, 2),
    (104, 9104, 268,  2, 10,   2, 1002, 1),
    (105, 9105, 1267, 2, 65,   1, 1001, 1),
    (106, 9106, 1267, 2, 65,   1, 1001, 1),
    (107, 9107, 900,  2, 1007, 1, 1001, 1),
    (108, 9108, 501,  2, 65,   1, 1001, 1),
    (109, 9109, 500,  2, 65,   1, 1002, 1),
    (110, 9110, 1267, 3, 65,   1, 1002, 1),
    (111, 9111, 1267, 1, 65,   1, 1002, 2),
    (112, 9112, 502,  2, 65,   1, 1001, 1),
    (113, 9113, 1267, 2, 65,   1, 1001, 1)`)
  // Romaneio 1 com `modified` vazio, como 356 mil dos 500 mil do Voalle: só entra
  // pela passada de `created`, e a instalação do 101 depende dele.
  await q(`create table erp.patrimony_packing_lists (id bigint, assignment_id bigint, contract_service_tag_id bigint, created timestamp, modified timestamp)`)
  await q(`insert into erp.patrimony_packing_lists values (1, 101, 1001, now(), null), (2, 104, 1002, now(), now())`)
  await q(`create table erp.patrimony_packing_list_items (id bigint, patrimony_packing_list_id bigint, out_date date,
           person_allocator_id bigint, created timestamp, modified timestamp)`)
  await q(`insert into erp.patrimony_packing_list_items values
    (11, 1, '2026-03-03', 77, '2026-03-03 10:00', now()),
    (12, 1, '2026-03-04', 99, '2026-03-04 10:00', now()),
    (21, 2, '2026-03-12', 78, '2026-03-12 17:00', now())`)
  // Como no Voalle: horário livre tem `modified` vazio; só a reserva o preenche.
  await q(`create table erp.service_desk_slots (id bigint, resource_id bigint, regions jsonb, slot_date date, reserved boolean,
           reserved_assignment_id bigint, deleted boolean, created timestamp, modified timestamp)`)
  await q(`insert into erp.service_desk_slots values
    (1, 77, '[23]', '2026-03-03', true, 101, false, '2026-02-20 10:00', '2026-03-01 09:00'),
    (2, 77, '[23]', '2026-03-03', true, 105, false, '2026-02-20 10:00', '2026-03-02 09:00'),
    (3, 78, '[23]', '2026-03-03', false, null, false, '2026-02-20 10:00', null),
    (4, 78, '[23]', '2026-03-03', true, null, true, '2026-02-20 10:00', '2026-03-02 10:00')`)
  await q(`create table erp.fsm_attendance_history (id bigint, reserved_assignment_id bigint, resource_id bigint, region_id bigint,
           routing_status integer, begin_date timestamp, end_date timestamp)`)
  await q(`insert into erp.fsm_attendance_history values
    (1, 101, 77, 23, 4, '2026-03-03 08:00', '2026-03-03 08:30'),
    (2, 105, 77, 23, 4, '2026-03-03 10:00', '2026-03-03 10:50'),
    (3, 101, 77, 23, 5, '2026-03-03 08:30', '2026-03-03 09:30'),
    (4, 105, 77, 23, 5, '2026-03-03 11:00', '2026-03-03 10:00'),
    (5, 105, 77, 23, 5, '2026-03-03 11:00', '2026-03-03 19:00')`)
})
after(shutdown)

const slugs = ONDA_2.datasets.map((d) => d.slug)
const linhas = (slug: string) => lakeRows(slug)
const porMes = (rows: Record<string, unknown>[], col: string) => new Map(rows.map((r) => [String(r[col]).slice(0, 7), r]))

describe('Pacotes de conjuntos: onda 2 (campo)', () => {
  it('contratos e pessoas usam as MESMAS colunas da onda 1 (instalar em qualquer ordem)', () => {
    for (const ref of ['voalle.contracts', 'voalle.people']) {
      assert.deepEqual(ONDA_2.sources.find((s) => s.ref === ref)!.columns, ONDA_1.sources.find((s) => s.ref === ref)!.columns, ref)
    }
  })

  it('instala só a onda 2 e todos os calculados materializam', async () => {
    const r = await as('master').post('/api/v1/packs/onda-2/install', { connectionId: conn })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const rep = r.body.report
    assert.deepEqual(rep.sources.filter((s: { status: string }) => s.status !== 'criada'), [], JSON.stringify(rep.sources))
    assert.deepEqual(rep.datasets.filter((d: { status: string }) => d.status !== 'criado'), [], JSON.stringify(rep.datasets))

    const cab = (await db.query(`select id from datasets where object_name = 'assignments' and kind = 'source'`)).rows[0]
    const cols = (await db.query('select source_column from dataset_fields where dataset_id = $1', [cab.id])).rows.map((x) => x.source_column)
    assert.ok(!cols.includes('title'), 'título do atendimento foi para o lake')

    const prontos = await waitFor(async () => {
      const r2 = (await db.query(`select slug, last_sync_at from datasets where kind = 'derived' and slug = any($1)`, [slugs])).rows
      return r2.length === slugs.length && r2.every((x) => x.last_sync_at) ? r2 : null
    }, 120_000)
    const faltam = prontos ? [] : (await db.query(
      `select d.slug, (select error from sync_runs s where s.dataset_id = d.id order by started_at desc limit 1) as erro
         from datasets d where d.kind = 'derived' and d.slug = any($1) and d.last_sync_at is null`, [slugs])).rows
    assert.ok(prontos, `não materializaram: ${JSON.stringify(faltam)}`)
  })

  it('protocolos: grupos, exclusões e horas até concluir', async () => {
    const p = new Map((await linhas('prata_voalle_protocolos_campo')).map((x) => [Number(x.atendimento_id), x]))
    // CGR (107), registro inicial (108) e apagado (113) ficam de fora.
    assert.deepEqual([...p.keys()].sort((a, b) => a - b), [101, 102, 103, 104, 105, 106, 109, 110, 111, 112])
    assert.equal(p.get(101)!.grupo, 'Ativação')
    assert.equal(p.get(104)!.grupo, 'Movimentação')
    assert.equal(p.get(105)!.grupo, 'Manutenção')
    assert.equal(p.get(105)!.retorno_problema, true)
    assert.equal(p.get(109)!.preventivo, true)
    assert.equal(p.get(110)!.cancelado, true)
    assert.equal(Number(p.get(105)!.horas_ate_concluir), 30)
    assert.equal(Number(p.get(101)!.contrato_id), 3, 'serviço → contrato')
    assert.equal(p.get(101)!.cidade, 'Canoas')
  })

  it('instalação: mês, prazo, demanda, retrabalho e fila', async () => {
    const inst = new Map((await linhas('prata_voalle_instalacoes')).map((x) => [Number(x.atendimento_id), x]))
    assert.deepEqual([...inst.keys()].sort(), [101, 104])
    assert.equal(String(inst.get(101)!.instalado_em).slice(0, 10), '2026-03-03', 'a primeira alocação é a instalação')
    assert.equal(Number(inst.get(101)!.tecnico_id), 77)

    const mar = porMes(await linhas('ouro_campo_instalacoes_mensal'), 'mes').get('2026-03')!
    assert.equal(Number(mar.ativacoes), 1)
    assert.equal(Number(mar.movimentacoes), 1)
    assert.equal(Number(mar.tecnicos), 2)
    assert.equal(Number(mar.dias_mediana_ate_instalar), 1)

    const dem = porMes(await linhas('ouro_campo_ativacao_demanda_mensal'), 'mes_abertura').get('2026-03')!
    assert.deepEqual([Number(dem.protocolos), Number(dem.instalados), Number(dem.cancelados), Number(dem.em_aberto)], [2, 1, 1, 0])
    assert.equal(Number(dem.conversao_pct), 50)

    const ret = porMes(await linhas('ouro_campo_retrabalho_instalacao_mensal'), 'mes').get('2026-03')!
    assert.deepEqual([Number(ret.instalacoes), Number(ret.com_retorno_30d)], [1, 1], 'o reparo de 20/03 no mesmo serviço é retrabalho')

    const fila = await linhas('ouro_campo_ativacao_fila_atual')
    assert.deepEqual(fila.map((f) => `${f.idade}|${f.cidade}|${Number(f.protocolos)}`), ['2 · 3 a 7 dias|Esteio|1'])
  })

  it('manutenção: mês, recorrência, coeficiente sobre a base e fila', async () => {
    const m = porMes(await linhas('ouro_campo_reparos_mensal'), 'mes')
    assert.deepEqual([Number(m.get('2026-03')!.abertos), Number(m.get('2026-03')!.concluidos), Number(m.get('2026-03')!.horas_mediana)], [1, 1, 30])
    assert.equal(Number(m.get('2026-03')!.ate_24h_pct), 0)
    // Abril: 106, 109 (preventivo) e 112 (requisição); 110 é cancelado.
    assert.deepEqual([Number(m.get('2026-04')!.abertos), Number(m.get('2026-04')!.preventivos_abertos), Number(m.get('2026-04')!.concluidos)], [3, 1, 3])
    assert.equal(Number(m.get('2026-04')!.horas_mediana), 5)

    const rec = porMes(await linhas('ouro_campo_reparos_recorrencia_mensal'), 'mes')
    assert.deepEqual([Number(rec.get('2026-04')!.reparos), Number(rec.get('2026-04')!.recorrentes_30d)], [2, 1],
      'o 106 vem 16 dias depois do 105 no mesmo serviço; a requisição (112) não conta')

    const dia = new Map((await linhas('ouro_campo_reparos_diarios')).map((x) => [String(x.dia).slice(0, 10), x]))
    assert.equal(Number(dia.get('2025-01-01')!.base_ativa), 1, 'base antes de 2025 entra como saldo inicial; telefonia fora')
    assert.equal(Number(dia.get('2025-04-01')!.base_ativa), 2)
    assert.equal(Number(dia.get('2025-09-01')!.base_ativa), 1, 'o contrato 2 cancelou em agosto')
    const d20 = dia.get('2026-03-20')!
    assert.deepEqual([Number(d20.reparos), Number(d20.base_ativa), Number(d20.coeficiente_pct), Number(d20.meta_pct)], [1, 2, 50, 0.12])

    const fila = await linhas('ouro_campo_reparos_fila_atual')
    assert.deepEqual(fila.map((f) => `${f.idade}|${Number(f.protocolos)}`), ['2 · 24 a 48 h|1'])
  })

  it('agenda: ocupação por região e tempos do app de campo', async () => {
    const ag = (await linhas('ouro_campo_agenda_ocupacao_diaria')).find((x) => String(x.dia).startsWith('2026-03-03'))!
    assert.equal(ag.regiao, 'Base São Leopoldo (Manutenção)')
    assert.deepEqual([Number(ag.horarios), Number(ag.reservados), Number(ag.tecnicos)], [3, 2, 2], 'slot apagado fica fora')

    const t = new Map((await linhas('ouro_campo_tempos_atendimento_mensal')).map((x) => [String(x.etapa), x]))
    assert.equal(Number(t.get('deslocamento')!.minutos_mediana), 40)
    assert.deepEqual([Number(t.get('execução')!.trechos), Number(t.get('execução')!.minutos_mediana)], [1, 60],
      'trecho invertido e trecho de 8 h ficam fora')
  })

  it('instalar de novo não duplica nada', async () => {
    const r = await as('master').post('/api/v1/packs/onda-2/install', { connectionId: conn })
    assert.equal(r.status, 200)
    assert.ok(r.body.report.sources.every((s: { status: string }) => s.status === 'reaproveitada'))
    assert.ok(r.body.report.datasets.every((d: { status: string }) => d.status === 'ja-existe'))
  })
})
