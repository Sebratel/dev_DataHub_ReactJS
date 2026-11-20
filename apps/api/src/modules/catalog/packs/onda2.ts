// ─────────────────────────────────────────────────────────────────────────
// Pacote "Onda 2" — campo: instalação, manutenção e agenda (20/11/2026).
//
// As regras vêm de dois painéis que já foram conferidos protocolo a protocolo
// com a operação, e valem aqui sem reinvenção:
//   • Instalação (dev_ReactJS_InstallationInsights, server/src/sql.js):
//     - instalado = material ALOCADO no protocolo
//       (patrimony_packing_list_items.out_date). Cai no mesmo dia da primeira
//       conexão no AutoISP em 99,7% dos casos (medido em 10/11/2026);
//     - ativação, movimentação e "retorno por problema em 30 dias" são listas
//       de tipo de protocolo (incident_type_id).
//   • Manutenção (dados_ReactJS_MaintenanceDashboard, src/config/regras-negocio.ts):
//     - universo = equipe de manutenção OU catálogo de manutenção. A equipe
//       vale até abr/2025 e o catálogo de jun/2025 em diante; o OR mantém a
//       série contínua;
//     - saem os tipos que não são demanda de campo, as centrais (COR, CGR,
//       Suporte, Corporativo, CAOC) e o cancelado;
//     - tempo até concluir = conclusion_date − created.
// Diferença conhecida: o painel de Manutenção também tira o colaborador que
// abre protocolo como cliente (regra pelo NOME). Aqui não há nome de pessoa
// no lake; são ~5 protocolos por ano.
//
// Contratos e pessoas reaproveitam as cópias da onda 1 com as MESMAS colunas,
// para os pacotes poderem ser instalados em qualquer ordem.
//
// Toda carga por `modified` tem `created` como segunda chave: o Voalle deixa
// `modified` vazio em muita linha. Medido em 20/11/2026, desde 2025 ficariam de
// fora 147 mil atendimentos e 158 mil romaneios (de 173 mil) com só `modified`.
// ─────────────────────────────────────────────────────────────────────────
import type { Pack, PackSource } from '../packs.js'
import { ONDA_1 } from './onda1.js'

const DESDE = '2025-01-01'
const daOnda1 = (ref: string): PackSource => {
  const s = ONDA_1.sources.find((x) => x.ref === ref)
  if (!s) throw new Error(`onda 2: fonte ${ref} não está na onda 1`)
  return s
}

const ATIVACAO = [12, 1014, 1297, 1254, 1255, 1136, 249, 1015]
const MOVIMENTACAO = [268, 279, 15, 1298, 1256]
const RETORNO_PROBLEMA = [1267, 1174, 1253, 1160, 1270]
const EQUIPES_MANUTENCAO = [1050, 65, 1065, 1064, 1063, 1062]
const EQUIPES_FORA = [1007, 1074, 1025, 67, 1117, 1084]
const CATALOGOS_MANUTENCAO = ['Oper. Reparo', 'Oper. Tecnologia', 'Equipe tecnologia', 'Equipe reparo']
const TIPOS_FORA = ['GERAL - Registro de Atendimento Inicial', 'TEC - Migração com troca de Equipamento']
const TIPOS_FORA_DA_RECORRENCIA = ['TEC-MANUT-ACESSO-CLI-REQUISICAO', 'TEC-MANUT-INT-CLIN-REGULARIZACAO']
const TIPOS_PREVENTIVOS = ['TEC-MANUT-ACESSO-CLI-PREVENCAO/PROBLEMA', 'TEC-MANUT-ACESSO-CLI-PREVENCAO/RECORRENTE']
const STATUS_ENCERRADO = ['Encerrado', 'A Faturar', 'Faturado']

const lista = (xs: (string | number)[]) => xs.map((x) => (typeof x === 'number' ? String(x) : `'${x.replace(/'/g, "''")}'`)).join(', ')

// Regiões da agenda (field service) que têm nome conhecido; as outras saem como "Região N".
const REGIAO = `case regiao_id
      when 23 then 'Base São Leopoldo (Manutenção)'
      when 24 then 'Base Canoas (Manutenção)'
      when 29 then 'Base Canoas (Ativação)'
      when 30 then 'Base São Leopoldo (Ativação)'
      else 'Região ' || cast(regiao_id as varchar) end`

const MESES_DESDE = `meses as (
    select cast(m as date) as mes
      from generate_series(timestamp '${DESDE}', cast(date_trunc('month', current_date) as timestamp), interval 1 month) as g(m)
  )`

export const ONDA_2: Pack = {
  id: 'onda-2',
  name: 'Onda 2 · Campo: instalação, manutenção e agenda',
  description: 'Instalações (prazo, conversão, retrabalho em 30 dias, fila), reparos (volume, tempo até concluir, recorrência, coeficiente sobre a base, fila) e agenda de campo (ocupação e tempos de deslocamento e execução). Desde 2025.',

  sources: [
    daOnda1('voalle.contracts'),
    daOnda1('voalle.people'),
    {
      ref: 'voalle.assignments', system: 'voalle', schema: 'erp', table: 'assignments',
      name: 'Voalle · Atendimentos (cabeçalho)', description: 'Abertura, conclusão e solicitante de cada atendimento alterado desde 2025. Título e descrição ficam de fora.',
      columns: ['id', 'assignment_type', 'requestor_id', 'created', 'conclusion_date', 'final_date', 'modified', 'deleted'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', incrementalKey2: 'created', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.assignment_incidents', system: 'voalle', schema: 'erp', table: 'assignment_incidents',
      name: 'Voalle · Protocolos', description: 'Tipo, status, equipe, catálogo e serviço de cada protocolo. Sem data de alteração no Voalle: cópia completa diária, só com estas colunas.',
      columns: ['assignment_id', 'protocol', 'incident_type_id', 'incident_status_id', 'team_id', 'catalog_service_id', 'contract_service_tag_id'],
      sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.incident_types', system: 'voalle', schema: 'erp', table: 'incident_types',
      name: 'Voalle · Tipos de protocolo', description: 'Código e nome dos tipos de protocolo.',
      columns: ['id', 'code', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.incident_status', system: 'voalle', schema: 'erp', table: 'incident_status',
      name: 'Voalle · Status de protocolo', description: 'Nome dos status (Abertura, Andamento, Encerrado, Cancelado…).',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.teams', system: 'voalle', schema: 'erp', table: 'teams',
      name: 'Voalle · Equipes', description: 'Nome das equipes.',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.catalog_services', system: 'voalle', schema: 'erp', table: 'catalog_services',
      name: 'Voalle · Catálogo de serviços', description: 'Nome dos catálogos (Oper. Reparo, Equipe ativação…).',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.contract_service_tags', system: 'voalle', schema: 'erp', table: 'contract_service_tags',
      name: 'Voalle · Serviços do contrato', description: 'Liga o serviço (etiqueta) ao contrato. Endereço fica de fora.',
      columns: ['id', 'contract_id', 'created', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', incrementalKey2: 'created', dedupeKeys: ['id'], syncCadence: 'daily' },
    },
    {
      ref: 'voalle.patrimony_packing_lists', system: 'voalle', schema: 'erp', table: 'patrimony_packing_lists',
      name: 'Voalle · Romaneios de material', description: 'Romaneio de material por atendimento, alterados desde 2025.',
      columns: ['id', 'assignment_id', 'contract_service_tag_id', 'created', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', incrementalKey2: 'created', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.patrimony_packing_list_items', system: 'voalle', schema: 'erp', table: 'patrimony_packing_list_items',
      name: 'Voalle · Itens dos romaneios', description: 'Saída de cada equipamento (a data de alocação marca a instalação) e quem alocou, desde 2025.',
      columns: ['id', 'patrimony_packing_list_id', 'out_date', 'person_allocator_id', 'created', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', incrementalKey2: 'created', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.service_desk_slots', system: 'voalle', schema: 'erp', table: 'service_desk_slots',
      // `modified` só é preenchido quando o horário é reservado (out/26: 15,1 mil de 26,5 mil),
      // então são duas chaves: `created` traz o horário novo (livre) e `modified` a reserva.
      name: 'Voalle · Agenda de campo (slots)', description: 'Horários da agenda por técnico e região, desde 2025. Dois passes: horário novo (created) e reserva (modified).',
      columns: ['id', 'resource_id', 'regions', 'slot_date', 'reserved', 'reserved_assignment_id', 'deleted', 'created', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', incrementalKey2: 'created', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.fsm_attendance_history', system: 'voalle', schema: 'erp', table: 'fsm_attendance_history',
      name: 'Voalle · Histórico do app de campo', description: 'Cada estado do atendimento no app (deslocamento, execução…), desde 2025. A carga relê 2 dias para pegar o fim de quem ainda estava em andamento.',
      columns: ['id', 'reserved_assignment_id', 'resource_id', 'region_id', 'routing_status', 'begin_date', 'end_date'],
      sync: { syncMode: 'incremental', incrementalKey: 'begin_date', dedupeKeys: ['id'], syncSince: DESDE, watermarkLagMinutes: 2880, syncCadence: 'daily' },
    },
  ],

  datasets: [
    // ── Prata ─────────────────────────────────────────────────────────────
    {
      slug: 'prata_voalle_protocolos_campo', domain: 'campo',
      name: 'Protocolos de campo (tratado)',
      description: 'Um protocolo por linha, desde 2025: ativação, movimentação, manutenção e os retornos por problema. Tipo, status, equipe, catálogo, contrato, serviço, cidade e bairro do cliente, abertura, conclusão e horas até concluir.',
      sql: `with base as (
    select
      cast(ai.assignment_id as bigint) as atendimento_id,
      cast(ai.protocol as bigint) as protocolo,
      cast(ai.incident_type_id as bigint) as tipo_id,
      it.title as tipo,
      st.title as status,
      cast(ai.team_id as bigint) as equipe_id,
      tm.title as equipe,
      cs.title as catalogo,
      cast(ai.contract_service_tag_id as bigint) as servico_id,
      cast(cst.contract_id as bigint) as contrato_id,
      cast(a.requestor_id as bigint) as cliente_id,
      a.created as aberto_em,
      a.conclusion_date as concluido_em
    from {{voalle.assignment_incidents}} ai
    join {{voalle.assignments}} a on a.id = ai.assignment_id
    left join {{voalle.incident_types}} it on it.id = ai.incident_type_id
    left join {{voalle.incident_status}} st on st.id = ai.incident_status_id
    left join {{voalle.teams}} tm on tm.id = ai.team_id
    left join {{voalle.catalog_services}} cs on cs.id = ai.catalog_service_id
    left join {{voalle.contract_service_tags}} cst on cst.id = ai.contract_service_tag_id
    where not coalesce(a.deleted, false) and a.created >= timestamp '${DESDE}'
  ), classificado as (
    select b.*,
      case
        when b.tipo_id in (${lista(ATIVACAO)}) then 'Ativação'
        when b.tipo_id in (${lista(MOVIMENTACAO)}) then 'Movimentação'
        when (b.equipe_id in (${lista(EQUIPES_MANUTENCAO)}) or b.catalogo in (${lista(CATALOGOS_MANUTENCAO)}))
             and coalesce(b.equipe_id, -1) not in (${lista(EQUIPES_FORA)})
             and coalesce(b.tipo, '') not in (${lista(TIPOS_FORA)}) then 'Manutenção'
        else 'Outros' end as grupo,
      b.tipo_id in (${lista(RETORNO_PROBLEMA)}) as retorno_problema
    from base b
  )
select c.*,
  coalesce(c.status, '') in (${lista(STATUS_ENCERRADO)}) as encerrado,
  coalesce(c.status, '') = 'Cancelado' as cancelado,
  coalesce(c.tipo, '') in (${lista(TIPOS_PREVENTIVOS)}) as preventivo,
  case when c.concluido_em is not null and c.concluido_em >= c.aberto_em
       then round(date_diff('second', c.aberto_em, c.concluido_em) / 3600.0, 4) end as horas_ate_concluir,
  pe.city as cidade,
  pe.neighborhood as bairro
from classificado c
left join {{voalle.people}} pe on pe.id = c.cliente_id
where c.grupo <> 'Outros' or c.retorno_problema`,
    },
    {
      slug: 'prata_voalle_instalacoes', domain: 'campo',
      name: 'Instalações (tratado)',
      description: 'Uma instalação por linha: protocolo de ativação ou movimentação com material alocado. Data da alocação (= instalação), quem alocou (id do técnico), contrato, serviço, cidade, bairro e dias desde a abertura do protocolo.',
      sql: `with alocado as (
    select l.assignment_id,
           min(i.out_date) as instalado_em,
           arg_min(i.person_allocator_id, i.created) as tecnico_id
      from {{voalle.patrimony_packing_list_items}} i
      join {{voalle.patrimony_packing_lists}} l on l.id = i.patrimony_packing_list_id
     where i.out_date is not null
     group by l.assignment_id
  )
select p.atendimento_id, p.protocolo, p.tipo_id, p.tipo, p.grupo, p.status,
  p.contrato_id, p.servico_id, p.cliente_id, p.cidade, p.bairro,
  cast(p.aberto_em as date) as aberto_em,
  cast(al.instalado_em as date) as instalado_em,
  cast(al.tecnico_id as bigint) as tecnico_id,
  date_diff('day', cast(p.aberto_em as date), cast(al.instalado_em as date)) as dias_ate_instalar
from prata_voalle_protocolos_campo p
join alocado al on al.assignment_id = p.atendimento_id
where p.grupo in ('Ativação', 'Movimentação')`,
    },

    // ── Instalação ────────────────────────────────────────────────────────
    {
      slug: 'ouro_campo_instalacoes_mensal', domain: 'campo',
      name: 'Instalações por mês',
      description: 'Instalações de cliente novo (ativação) e movimentações por mês da alocação do material, técnicos que instalaram, prazo mediano desde a abertura e quanto foi instalado em até 2 dias.',
      sql: `select cast(date_trunc('month', instalado_em) as date) as mes,
  count(*) filter (where grupo = 'Ativação') as ativacoes,
  count(*) filter (where grupo = 'Movimentação') as movimentacoes,
  count(distinct tecnico_id) as tecnicos,
  median(dias_ate_instalar) filter (where grupo = 'Ativação' and dias_ate_instalar >= 0) as dias_mediana_ate_instalar,
  round(100.0 * count(*) filter (where grupo = 'Ativação' and dias_ate_instalar between 0 and 2)
        / nullif(count(*) filter (where grupo = 'Ativação'), 0), 2) as ativacoes_ate_2_dias_pct
from prata_voalle_instalacoes
where instalado_em >= date '${DESDE}'
group by 1
order by 1`,
    },
    {
      slug: 'ouro_campo_instalacoes_diarias', domain: 'campo',
      name: 'Instalações por dia',
      description: 'Ativações e movimentações instaladas em cada dia, com o dia da semana e os técnicos que instalaram. Base para capacidade e previsão por dia.',
      sql: `select instalado_em as dia,
  dayofweek(instalado_em) as dia_semana_num,
  case dayofweek(instalado_em) when 0 then 'dom' when 1 then 'seg' when 2 then 'ter' when 3 then 'qua'
       when 4 then 'qui' when 5 then 'sex' else 'sáb' end as dia_semana,
  count(*) filter (where grupo = 'Ativação') as ativacoes,
  count(*) filter (where grupo = 'Movimentação') as movimentacoes,
  count(distinct tecnico_id) as tecnicos
from prata_voalle_instalacoes
where instalado_em >= date '${DESDE}' and instalado_em <= current_date
group by 1
order by 1`,
    },
    {
      slug: 'ouro_campo_ativacao_demanda_mensal', domain: 'campo',
      name: 'Ativação: demanda e desfecho por mês de abertura',
      description: 'Protocolos de ativação abertos em cada mês e o destino deles: instalados, cancelados, encerrados sem material e ainda em aberto; conversão e prazo mediano até instalar.',
      sql: `select cast(date_trunc('month', p.aberto_em) as date) as mes_abertura,
  count(*) as protocolos,
  count(i.atendimento_id) as instalados,
  count(*) filter (where i.atendimento_id is null and p.cancelado) as cancelados,
  count(*) filter (where i.atendimento_id is null and p.encerrado) as encerrados_sem_material,
  count(*) filter (where i.atendimento_id is null and not p.cancelado and not p.encerrado) as em_aberto,
  round(100.0 * count(i.atendimento_id) / count(*), 2) as conversao_pct,
  median(i.dias_ate_instalar) filter (where i.dias_ate_instalar >= 0) as dias_mediana_ate_instalar
from prata_voalle_protocolos_campo p
left join prata_voalle_instalacoes i on i.atendimento_id = p.atendimento_id
where p.grupo = 'Ativação'
group by 1
order by 1`,
    },
    {
      slug: 'ouro_campo_retrabalho_instalacao_mensal', domain: 'campo',
      name: 'Retrabalho da instalação (retorno em 30 dias)',
      description: 'Instalações de cliente novo de cada mês e quantas tiveram protocolo de retorno por problema no mesmo serviço em até 30 dias. Requisição, troca e prevenção não contam. O mês só fecha 30 dias depois do fim.',
      sql: `with inst as (
    select atendimento_id, servico_id, instalado_em
      from prata_voalle_instalacoes
     where grupo = 'Ativação' and servico_id is not null
  ), retorno as (
    select distinct i.atendimento_id
      from inst i
      join prata_voalle_protocolos_campo r
        on r.servico_id = i.servico_id and r.retorno_problema and not r.cancelado
       and r.aberto_em > cast(i.instalado_em as timestamp)
       and r.aberto_em < cast(i.instalado_em as timestamp) + interval 30 day
  )
select cast(date_trunc('month', i.instalado_em) as date) as mes,
  count(*) as instalacoes,
  count(r.atendimento_id) as com_retorno_30d,
  round(100.0 * count(r.atendimento_id) / count(*), 2) as retrabalho_pct,
  max(i.instalado_em) + interval 30 day <= current_date as janela_completa
from inst i
left join retorno r on r.atendimento_id = i.atendimento_id
group by 1
order by 1`,
    },
    {
      slug: 'ouro_campo_ativacao_fila_atual', domain: 'campo',
      name: 'Ativação: fila de hoje por idade e cidade',
      description: 'Protocolos de ativação abertos, sem instalação, sem cancelamento e não encerrados, por faixa de dias em aberto e cidade.',
      sql: `select
  case when date_diff('day', cast(p.aberto_em as date), current_date) <= 2 then '1 · até 2 dias'
       when date_diff('day', cast(p.aberto_em as date), current_date) <= 7 then '2 · 3 a 7 dias'
       when date_diff('day', cast(p.aberto_em as date), current_date) <= 15 then '3 · 8 a 15 dias'
       when date_diff('day', cast(p.aberto_em as date), current_date) <= 30 then '4 · 16 a 30 dias'
       else '5 · mais de 30 dias' end as idade,
  coalesce(p.cidade, 'Sem cidade') as cidade,
  count(*) as protocolos
from prata_voalle_protocolos_campo p
left join prata_voalle_instalacoes i on i.atendimento_id = p.atendimento_id
where p.grupo = 'Ativação' and i.atendimento_id is null and not p.cancelado and not p.encerrado
group by 1, 2
order by 1, 3 desc`,
    },

    // ── Manutenção ────────────────────────────────────────────────────────
    {
      slug: 'ouro_campo_reparos_mensal', domain: 'campo',
      name: 'Manutenção: reparos e tempo até concluir por mês',
      description: 'Protocolos de manutenção abertos em cada mês e, pelo mês de conclusão, os concluídos com tempo médio e mediano até concluir (horas) e quanto foi concluído em até 24 h. Cancelados ficam fora.',
      sql: `with ${MESES_DESDE},
  m as (select * from prata_voalle_protocolos_campo where grupo = 'Manutenção' and not cancelado),
  abertos as (select cast(date_trunc('month', aberto_em) as date) as mes, count(*) as abertos,
                     count(*) filter (where preventivo) as preventivos_abertos
                from m group by 1),
  concluidos as (select cast(date_trunc('month', concluido_em) as date) as mes,
                        count(*) as concluidos,
                        round(avg(horas_ate_concluir), 2) as horas_media,
                        round(median(horas_ate_concluir), 2) as horas_mediana,
                        round(100.0 * count(*) filter (where horas_ate_concluir <= 24) / count(*), 2) as ate_24h_pct
                   from m where encerrado and horas_ate_concluir is not null group by 1)
select x.mes, coalesce(a.abertos, 0) as abertos, coalesce(a.preventivos_abertos, 0) as preventivos_abertos,
  coalesce(c.concluidos, 0) as concluidos, c.horas_media, c.horas_mediana, c.ate_24h_pct
from meses x
left join abertos a on a.mes = x.mes
left join concluidos c on c.mes = x.mes
order by x.mes`,
    },
    {
      slug: 'ouro_campo_reparos_diarios', domain: 'campo',
      name: 'Manutenção: reparos por dia e coeficiente sobre a base',
      description: 'Reparos abertos por dia, a base ativa no dia e o coeficiente (reparos ÷ base), comparado com a meta da operação por dia da semana (0,12% em dia útil, 0,08% no sábado, 0,06% no domingo).',
      sql: `with eventos as (
    select cast(approval_date as date) as dia, 1 as delta
      from {{voalle.contracts}}
     where stage = 3 and approval_date is not null and not coalesce(deleted, false) and contract_type_id <> 19
    union all
    select cast(cancellation_date as date), -1
      from {{voalle.contracts}}
     where stage = 3 and approval_date is not null and cancellation_date is not null
       and not coalesce(deleted, false) and contract_type_id <> 19
  ), dias as (
    select cast(d as date) as dia from generate_series(timestamp '${DESDE}', cast(current_date as timestamp), interval 1 day) as g(d)
  ), saldo as (
    select dia, sum(delta) as delta from eventos group by 1
  ), inicial as (
    select coalesce(sum(delta), 0) as base from eventos where dia < date '${DESDE}'
  ), base as (
    -- Base no fim do dia = o que já existia antes de ${DESDE} + instalações − cancelamentos até o dia.
    select d.dia,
      (select base from inicial) + sum(coalesce(s.delta, 0)) over (order by d.dia rows between unbounded preceding and current row) as base_ativa
    from dias d
    left join saldo s on s.dia = d.dia
  ), reparos as (
    select cast(aberto_em as date) as dia, count(*) as reparos
      from prata_voalle_protocolos_campo
     where grupo = 'Manutenção' and not cancelado and not preventivo
     group by 1
  )
select b.dia,
  dayofweek(b.dia) as dia_semana_num,
  coalesce(r.reparos, 0) as reparos,
  b.base_ativa,
  round(100.0 * coalesce(r.reparos, 0) / nullif(b.base_ativa, 0), 4) as coeficiente_pct,
  case dayofweek(b.dia) when 0 then 0.06 when 6 then 0.08 else 0.12 end as meta_pct
from base b
left join reparos r on r.dia = b.dia
order by b.dia`,
    },
    {
      slug: 'ouro_campo_reparos_por_tipo_mensal', domain: 'campo',
      name: 'Manutenção: reparos por tipo e mês',
      description: 'Protocolos de manutenção por mês de abertura e tipo, com quantos foram concluídos e o tempo mediano até concluir.',
      sql: `select cast(date_trunc('month', aberto_em) as date) as mes,
  coalesce(tipo, 'Sem tipo') as tipo,
  count(*) as abertos,
  count(*) filter (where encerrado) as concluidos,
  round(median(horas_ate_concluir) filter (where encerrado), 2) as horas_mediana
from prata_voalle_protocolos_campo
where grupo = 'Manutenção' and not cancelado
group by 1, 2
order by 1, 3 desc`,
    },
    {
      slug: 'ouro_campo_reparos_por_cidade_mensal', domain: 'campo',
      name: 'Manutenção: reparos por cidade e mês',
      description: 'Protocolos de manutenção por mês de abertura e cidade do cliente, com o tempo mediano até concluir.',
      sql: `select cast(date_trunc('month', aberto_em) as date) as mes,
  coalesce(cidade, 'Sem cidade') as cidade,
  count(*) as abertos,
  round(median(horas_ate_concluir) filter (where encerrado), 2) as horas_mediana
from prata_voalle_protocolos_campo
where grupo = 'Manutenção' and not cancelado
group by 1, 2
order by 1, 3 desc`,
    },
    {
      slug: 'ouro_campo_reparos_recorrencia_mensal', domain: 'campo',
      name: 'Manutenção: recorrência (outro reparo em 30 dias)',
      description: 'Reparos de cada mês e quantos aconteceram no mesmo serviço até 30 dias depois de outro reparo — o cliente voltou a ter problema. Requisição e regularização não contam.',
      sql: `with r as (
    select servico_id, aberto_em,
           lag(aberto_em) over (partition by servico_id order by aberto_em) as anterior
      from prata_voalle_protocolos_campo
     where grupo = 'Manutenção' and not cancelado and servico_id is not null
       and coalesce(tipo, '') not in (${lista(TIPOS_FORA_DA_RECORRENCIA)})
  )
select cast(date_trunc('month', aberto_em) as date) as mes,
  count(*) as reparos,
  count(*) filter (where anterior is not null and aberto_em - anterior <= interval 30 day) as recorrentes_30d,
  round(100.0 * count(*) filter (where anterior is not null and aberto_em - anterior <= interval 30 day) / count(*), 2) as recorrencia_pct
from r
group by 1
order by 1`,
    },
    {
      slug: 'ouro_campo_reparos_fila_atual', domain: 'campo',
      name: 'Manutenção: fila de hoje por idade e equipe',
      description: 'Protocolos de manutenção em aberto hoje (nem concluídos nem cancelados) por faixa de horas em aberto e equipe.',
      sql: `select
  case when date_diff('hour', aberto_em, current_timestamp::timestamp) <= 24 then '1 · até 24 h'
       when date_diff('hour', aberto_em, current_timestamp::timestamp) <= 48 then '2 · 24 a 48 h'
       when date_diff('hour', aberto_em, current_timestamp::timestamp) <= 72 then '3 · 48 a 72 h'
       when date_diff('hour', aberto_em, current_timestamp::timestamp) <= 168 then '4 · 3 a 7 dias'
       else '5 · mais de 7 dias' end as idade,
  coalesce(equipe, 'Sem equipe') as equipe,
  count(*) as protocolos
from prata_voalle_protocolos_campo
where grupo = 'Manutenção' and not cancelado and not encerrado
group by 1, 2
order by 1, 3 desc`,
    },

    // ── Agenda de campo ───────────────────────────────────────────────────
    {
      slug: 'ouro_campo_agenda_ocupacao_diaria', domain: 'campo',
      name: 'Agenda de campo: ocupação por dia e região',
      description: 'Horários de agenda por dia e região (base): total, reservados, ocupação e técnicos com agenda. Inclui os próximos dias já abertos.',
      sql: `with s as (
    select cast(slot_date as date) as dia,
           cast(regexp_extract(cast(regions as varchar), '[0-9]+') as integer) as regiao_id,
           resource_id, reserved
      from {{voalle.service_desk_slots}}
     where not coalesce(deleted, false) and slot_date >= timestamp '${DESDE}'
  )
select dia, regiao_id, ${REGIAO} as regiao,
  count(*) as horarios,
  count(*) filter (where reserved) as reservados,
  round(100.0 * count(*) filter (where reserved) / count(*), 2) as ocupacao_pct,
  count(distinct resource_id) as tecnicos
from s
group by 1, 2, 3
order by 1, 2`,
    },
    {
      slug: 'ouro_campo_tempos_atendimento_mensal', domain: 'campo',
      name: 'Agenda de campo: tempo de deslocamento e de execução',
      description: 'Pelo app de campo: tempo mediano e percentil 90 em deslocamento e em execução, por mês e região. Trechos sem fim, invertidos ou acima de 6 h ficam fora.',
      sql: `with h as (
    select cast(date_trunc('month', begin_date) as date) as mes,
           cast(region_id as integer) as regiao_id,
           case cast(routing_status as integer) when 4 then 'deslocamento' when 5 then 'execução' end as etapa,
           date_diff('second', begin_date, end_date) / 60.0 as minutos
      from {{voalle.fsm_attendance_history}}
     where routing_status in (4, 5) and end_date is not null and end_date > begin_date
       and end_date - begin_date < interval 6 hour and begin_date >= timestamp '${DESDE}'
  )
select mes, regiao_id, ${REGIAO} as regiao, etapa,
  count(*) as trechos,
  round(median(minutos), 1) as minutos_mediana,
  round(quantile_cont(minutos, 0.9), 1) as minutos_p90
from h
group by 1, 2, 3, 4
order by 1, 2, 4`,
    },
  ],
}
