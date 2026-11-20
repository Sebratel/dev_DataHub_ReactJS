// ─────────────────────────────────────────────────────────────────────────
// Pacote "Onda 1" — financeiro, cancelamento, base e receita (19/11/2026).
//
// Regras do Voalle que este pacote assume (conferidas no banco em 19/11/2026
// e nas análises do Health Score — ver docs/RUNBOOK.md, "Pacotes"):
//   • UNIDADE = CONTRATO, não cliente (uma pessoa pode ter vários).
//   • Instalado = stage 3 ("Aprovado"); approval_date é o dia da instalação
//     (3 a 6 dias depois da venda). Contrato que cancela com outro stage
//     nunca foi instalado — venda que morreu, não cliente que saiu.
//   • Fora sempre: contrato de telefonia (tipo 19) e linha apagada (deleted).
//   • Ativo no fim do mês E = instalado até E e sem cancelamento até E.
//     Bate com a reconstrução validada contra a operação (~2% de diferença).
//   • Cancelamento que NÃO é churn: venda de operação em lote (FNC.CAN.020) e
//     contrato duplicado (OTR.CAN.006). Taxa = cancelamentos do mês ÷ base
//     ativa no fim do mês anterior (a fórmula oficial).
//   • Cortesia (tipo 3) e adequação de condomínio (tipo 36) não são
//     faturados: ficam na base, com receita zero.
//   • Valor mensal = contracts.amount (receita contratada).
//   • FATURA: cada mês tem DOIS títulos com o mesmo valor — a fatura que o
//     cliente recebe ("FAT…", bill_title_id vazio) e os títulos-componente que
//     apontam para ela. Somar os dois dobra a receita (e as baixas). Aqui só a
//     fatura conta.
//   • Fatura renegociada sai do atraso: o saldo dela foi para os títulos novos.
//   • O motivo de cancelamento é o código do último evento de cancelamento
//     (contract_event_types). Ele mede também o hábito de quem digita
//     (mudança de endereço varia 32x entre atendentes): use com cuidado.
// ─────────────────────────────────────────────────────────────────────────
import type { Pack } from '../packs.js'
import { NOTEBOOKS_ONDA_1 } from './onda1Notebooks.js'

const DESDE = '2023-01-01'

// Meses de jan/2023 até o mês corrente, com o último dia de cada um.
const MESES = `meses as (
    select cast(m as date) as mes, cast(m + interval 1 month - interval 1 day as date) as fim
      from generate_series(timestamp '${DESDE}', cast(date_trunc('month', current_date) as timestamp), interval 1 month) as g(m)
  )`

// Base ativa por mês (um contrato por linha × mês em que estava ativo no fim).
const ATIVOS_NO_FIM = `ativos_no_fim as (
    select m.mes, m.fim, c.*
      from meses m
      join prata_voalle_contratos c
        on c.instalado and c.instalado_em <= m.fim and (c.cancelado_em is null or c.cancelado_em > m.fim)
  )`

// Cancelamento que conta como churn: contrato instalado, fora lote e duplicado.
const CHURN = `c.instalado and c.cancelado_em is not null
      and coalesce(c.motivo_codigo, '') not in ('FNC.CAN.020', 'OTR.CAN.006')`

const FAIXA_VALOR = `case
      when c.valor_mensal <= 0 then '0 · não faturado'
      when c.valor_mensal < 80 then '1 · até R$ 79'
      when c.valor_mensal < 100 then '2 · R$ 80 a 99'
      when c.valor_mensal < 120 then '3 · R$ 100 a 119'
      when c.valor_mensal < 150 then '4 · R$ 120 a 149'
      when c.valor_mensal < 200 then '5 · R$ 150 a 199'
      else '6 · R$ 200 ou mais' end`

const FAIXA_CASA = `case
      when c.dias_de_casa < 90 then '1 · até 3 meses'
      when c.dias_de_casa < 180 then '2 · 3 a 6 meses'
      when c.dias_de_casa < 365 then '3 · 6 a 12 meses'
      when c.dias_de_casa < 730 then '4 · 1 a 2 anos'
      when c.dias_de_casa < 1095 then '5 · 2 a 3 anos'
      when c.dias_de_casa < 1825 then '6 · 3 a 5 anos'
      else '7 · 5 anos ou mais' end`

export const ONDA_1: Pack = {
  id: 'onda-1',
  name: 'Onda 1 · Financeiro, cancelamento, base e receita',
  description: 'Base ativa, movimentação, receita contratada, cancelamento (taxa oficial, motivo, safra), faturamento, recebimento e inadimplência — tudo por contrato.',

  sources: [
    {
      ref: 'voalle.contracts', system: 'voalle', schema: 'erp', table: 'contracts',
      name: 'Voalle · Contratos', description: 'Cópia dos contratos do Voalle, só com as colunas usadas pelos pacotes.',
      columns: ['id', 'contract_number', 'client_id', 'contract_type_id', 'status', 'stage', 'created', 'approval_date',
        'cancellation_date', 'amount', 'people_address_id', 'deleted', 'modified'],
      sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.contract_types', system: 'voalle', schema: 'erp', table: 'contract_types',
      name: 'Voalle · Tipos de contrato', description: 'Tipos de contrato do Voalle (PF, PJ, cortesia, formas de cobrança).',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.contract_events', system: 'voalle', schema: 'erp', table: 'contract_events',
      name: 'Voalle · Eventos de contrato', description: 'Eventos de contrato desde 2023 (o cancelamento traz o motivo).',
      columns: ['id', 'contract_id', 'contract_event_type_id', 'date', 'deleted', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.contract_event_types', system: 'voalle', schema: 'erp', table: 'contract_event_types',
      name: 'Voalle · Tipos de evento de contrato', description: 'Códigos e nomes dos eventos (ex.: IND.CAN.001 Cancelamento - Inadimplência).',
      columns: ['id', 'code', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.people', system: 'voalle', schema: 'erp', table: 'people',
      name: 'Voalle · Pessoas (sem dados pessoais)', description: 'Tipo (PF/PJ) e cidade do cadastro. Nome e documento ficam de fora.',
      columns: ['id', 'type_tx_id', 'city', 'neighborhood', 'state', 'deleted'],
      sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.people_addresses', system: 'voalle', schema: 'erp', table: 'people_addresses',
      name: 'Voalle · Endereços (cidade e bairro)', description: 'Cidade, bairro e UF dos endereços de instalação. Rua e número ficam de fora.',
      columns: ['id', 'city', 'neighborhood', 'state', 'deleted'],
      sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.financial_receivable_titles', system: 'voalle', schema: 'erp', table: 'financial_receivable_titles',
      name: 'Voalle · Títulos a receber', description: 'Títulos a receber alterados desde 2023 (faturas e componentes).',
      columns: ['id', 'contract_id', 'client_id', 'bill_title_id', 'financer_nature_id', 'title_amount', 'balance', 'issue_date',
        'expiration_date', 'competence', 'renegotiated', 'deleted', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.financers_natures', system: 'voalle', schema: 'erp', table: 'financers_natures',
      name: 'Voalle · Naturezas financeiras', description: 'Natureza de cada título (receita de SCM, telefonia, venda de equipamento, tarifa…).',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
    {
      ref: 'voalle.financial_receipt_titles', system: 'voalle', schema: 'erp', table: 'financial_receipt_titles',
      name: 'Voalle · Baixas de títulos', description: 'Recebimentos (baixas) alterados desde 2023.',
      columns: ['id', 'financial_receivable_title_id', 'receipt_date', 'client_paid_date', 'amount', 'payment_form_id', 'deleted', 'modified'],
      sync: { syncMode: 'incremental', incrementalKey: 'modified', dedupeKeys: ['id'], syncSince: DESDE, syncCadence: 'daily' },
    },
    {
      ref: 'voalle.payment_forms', system: 'voalle', schema: 'erp', table: 'payment_forms',
      name: 'Voalle · Formas de pagamento', description: 'Pix, boleto, cartão, dinheiro…',
      columns: ['id', 'title'], sync: { syncMode: 'snapshot', syncCadence: 'daily' },
    },
  ],

  datasets: [
    // ── Prata: contrato e fatura limpos, base de todo o resto ─────────────
    {
      slug: 'prata_voalle_contratos', domain: 'base',
      name: 'Contratos (tratado)',
      description: 'Um contrato por linha: tipo, PF/PJ, venda, instalação, cancelamento com motivo e grupo, valor mensal, cidade e bairro, tempo de casa. Sem telefonia nem apagados.',
      sql: `with ultimo_cancelamento as (
    select e.contract_id, t.code as motivo_codigo, t.title as motivo,
           row_number() over (partition by e.contract_id order by e.date desc, e.id desc) as n
      from {{voalle.contract_events}} e
      join {{voalle.contract_event_types}} t on t.id = e.contract_event_type_id
     where not coalesce(e.deleted, false) and t.code like '%.CAN.%'
  )
select
  cast(c.id as bigint) as contrato_id,
  c.contract_number as contrato_numero,
  cast(c.client_id as bigint) as cliente_id,
  cast(c.contract_type_id as bigint) as tipo_id,
  ct.title as tipo,
  case p.type_tx_id when 2 then 'PF' when 1 then 'PJ' else 'outro' end as pessoa,
  cast(c.status as integer) as status_codigo,
  cast(c.stage as integer) as etapa_codigo,
  c.stage = 3 and c.approval_date is not null as instalado,
  c.contract_type_id in (3, 36) as nao_faturado,
  case when c.created >= timestamp '2000-01-01' then cast(c.created as date) end as vendido_em, -- 1000-01-01 é o "nulo" do Voalle
  cast(c.approval_date as date) as instalado_em,
  cast(c.cancellation_date as date) as cancelado_em,
  m.motivo_codigo,
  m.motivo,
  case
    when c.cancellation_date is null then null
    when m.motivo_codigo = 'FNC.CAN.020' then 'Venda de operação (lote)'
    when m.motivo_codigo = 'OTR.CAN.006' then 'Contrato duplicado'
    when c.stage <> 3 or m.motivo ilike '%não instalado%' then 'Não instalado'
    when m.motivo_codigo = 'IND.CAN.001' then 'Inadimplência'
    when m.motivo_codigo = 'MDE.CAN.008' then 'Mudança de endereço'
    when m.motivo_codigo = 'CNC.CAN.013' then 'Concorrência'
    when m.motivo_codigo = 'INS.CAN.004' then 'Insatisfação'
    when m.motivo_codigo = 'OTR.CAN.009' then 'Falecimento'
    when m.motivo_codigo in ('OTR.CAN.002', 'FNC.CAN.007', 'CNC.CAN.014', 'OTR.CAN.020', 'OTR.CAN.010') then 'Voluntário (outros)'
    when m.motivo_codigo is null then 'Sem motivo registrado'
    else 'Outros'
  end as motivo_grupo,
  coalesce(m.motivo_codigo = 'FNC.CAN.020', false) as cancelado_em_lote,
  case when c.contract_type_id in (3, 36) then 0 else coalesce(c.amount, 0) end as valor_mensal,
  coalesce(nullif(trim(a.city), ''), p.city) as cidade,
  coalesce(nullif(trim(a.neighborhood), ''), p.neighborhood) as bairro,
  coalesce(nullif(trim(a.state), ''), p.state) as uf,
  case when c.stage = 3 and c.approval_date is not null
       then date_diff('day', cast(c.approval_date as date), coalesce(cast(c.cancellation_date as date), current_date))
  end as dias_de_casa
from {{voalle.contracts}} c
left join {{voalle.contract_types}} ct on ct.id = c.contract_type_id
left join {{voalle.people_addresses}} a on a.id = c.people_address_id
left join {{voalle.people}} p on p.id = c.client_id
left join ultimo_cancelamento m on m.contract_id = c.id and m.n = 1
where not coalesce(c.deleted, false) and c.contract_type_id <> 19`,
    },
    {
      slug: 'prata_voalle_faturas', domain: 'financeiro',
      name: 'Faturas (tratado)',
      description: 'Uma fatura por linha (a que o cliente recebe; componentes ficam de fora para não dobrar valor), com natureza, vencimento, valor, saldo, pagamento, forma, atraso. Vencimentos desde 2023; tarifa de baixa de título fica de fora. Planos anuais já têm as parcelas futuras geradas.',
      sql: `with baixas as (
    select r.financial_receivable_title_id as titulo_id,
           max(cast(coalesce(r.client_paid_date, r.receipt_date) as date)) as ultimo_pagamento,
           sum(r.amount) as valor_recebido,
           arg_max(f.title, r.amount) as forma_pagamento
      from {{voalle.financial_receipt_titles}} r
      left join {{voalle.payment_forms}} f on f.id = r.payment_form_id
     where not coalesce(r.deleted, false)
     group by r.financial_receivable_title_id
  ), faturas as (
    select
      cast(t.id as bigint) as fatura_id,
      cast(t.contract_id as bigint) as contrato_id,
      cast(t.client_id as bigint) as cliente_id,
      cast(t.issue_date as date) as emitida_em,
      cast(t.expiration_date as date) as vence_em,
      cast(t.competence as date) as competencia,
      coalesce(t.title_amount, 0) as valor,
      greatest(coalesce(t.balance, 0), 0) as saldo,
      coalesce(t.renegotiated, false) as renegociada,
      n.title as natureza,
      b.valor_recebido,
      b.forma_pagamento,
      b.ultimo_pagamento
    from {{voalle.financial_receivable_titles}} t
    left join {{voalle.financers_natures}} n on n.id = t.financer_nature_id
    left join baixas b on b.titulo_id = t.id
    where not coalesce(t.deleted, false) and t.bill_title_id is null
      and coalesce(n.title, '') <> 'DF - TARIFA BAIXA DE TÍTULO'
      and t.expiration_date >= timestamp '${DESDE}'
      and t.expiration_date < current_date + interval 400 day
  )
select f.*,
  f.saldo <= 0 and not f.renegociada as paga,
  case when f.saldo <= 0 and not f.renegociada then f.ultimo_pagamento end as paga_em,
  case when f.saldo <= 0 and not f.renegociada and f.ultimo_pagamento is not null
       then date_diff('day', f.vence_em, f.ultimo_pagamento) end as dias_pagamento_apos_vencimento,
  case when f.saldo > 0 and not f.renegociada and f.vence_em < current_date
       then date_diff('day', f.vence_em, current_date) else 0 end as dias_em_atraso
from faturas f`,
    },

    // ── Base e receita ──────────────────────────────────────────────────
    {
      slug: 'ouro_base_ativa_mensal', domain: 'base',
      name: 'Base ativa por mês',
      description: 'Contratos ativos no último dia de cada mês (o mês corrente mostra a base de hoje), PF/PJ, receita contratada e ticket médio (ARPU).',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM}
select mes, fim as data_base,
  count(*) as contratos_ativos,
  count(*) filter (where pessoa = 'PF') as contratos_pf,
  count(*) filter (where pessoa = 'PJ') as contratos_pj,
  count(*) filter (where nao_faturado) as contratos_nao_faturados,
  round(sum(valor_mensal), 2) as receita_contratada,
  round(sum(valor_mensal) / nullif(count(*) filter (where not nao_faturado), 0), 2) as arpu
from ativos_no_fim
group by mes, fim
order by mes`,
    },
    {
      slug: 'ouro_base_movimentacao_mensal', domain: 'base',
      name: 'Movimentação da base por mês',
      description: 'Vendas, instalações, cancelamentos (churn, sem lote e duplicado), cancelamentos em lote e saldo líquido de cada mês.',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM},
  base as (select mes, count(*) as base_fim from ativos_no_fim group by mes),
  vendas as (select cast(date_trunc('month', vendido_em) as date) as mes, count(*) as vendas
               from prata_voalle_contratos group by 1),
  instal as (select cast(date_trunc('month', instalado_em) as date) as mes, count(*) as instalacoes
               from prata_voalle_contratos where instalado group by 1),
  canc as (select cast(date_trunc('month', c.cancelado_em) as date) as mes,
                  count(*) filter (where ${CHURN}) as cancelamentos,
                  count(*) filter (where c.cancelado_em_lote) as cancelamentos_em_lote
             from prata_voalle_contratos c where c.cancelado_em is not null group by 1)
select m.mes,
  coalesce(v.vendas, 0) as vendas,
  coalesce(i.instalacoes, 0) as instalacoes,
  coalesce(k.cancelamentos, 0) as cancelamentos,
  coalesce(k.cancelamentos_em_lote, 0) as cancelamentos_em_lote,
  coalesce(i.instalacoes, 0) - coalesce(k.cancelamentos, 0) - coalesce(k.cancelamentos_em_lote, 0) as saldo_liquido,
  coalesce(b.base_fim, 0) as base_fim
from meses m
left join vendas v on v.mes = m.mes
left join instal i on i.mes = m.mes
left join canc k on k.mes = m.mes
left join base b on b.mes = m.mes
order by m.mes`,
    },
    {
      slug: 'ouro_receita_movimentacao_mensal', domain: 'base',
      name: 'Movimentação da receita contratada por mês',
      description: 'Receita mensal contratada que entrou (instalações), que saiu (cancelamentos, com e sem lote) e a variação líquida.',
      sql: `with ${MESES},
  entrou as (select cast(date_trunc('month', instalado_em) as date) as mes, sum(valor_mensal) as receita_nova
               from prata_voalle_contratos where instalado group by 1),
  saiu as (select cast(date_trunc('month', c.cancelado_em) as date) as mes,
                  sum(c.valor_mensal) filter (where ${CHURN}) as receita_cancelada,
                  sum(c.valor_mensal) filter (where c.cancelado_em_lote) as receita_cancelada_em_lote
             from prata_voalle_contratos c where c.cancelado_em is not null group by 1)
select m.mes,
  round(coalesce(e.receita_nova, 0), 2) as receita_nova,
  round(coalesce(s.receita_cancelada, 0), 2) as receita_cancelada,
  round(coalesce(s.receita_cancelada_em_lote, 0), 2) as receita_cancelada_em_lote,
  round(coalesce(e.receita_nova, 0) - coalesce(s.receita_cancelada, 0) - coalesce(s.receita_cancelada_em_lote, 0), 2) as variacao_liquida
from meses m
left join entrou e on e.mes = m.mes
left join saiu s on s.mes = m.mes
order by m.mes`,
    },
    {
      slug: 'ouro_base_ativa_por_cidade', domain: 'base',
      name: 'Base ativa por cidade (hoje)',
      description: 'Contratos ativos hoje por cidade: quantidade, receita contratada, ARPU e participação na base.',
      sql: `with ativos as (
    select * from prata_voalle_contratos c where c.instalado and c.cancelado_em is null
  )
select coalesce(cidade, 'Sem cidade') as cidade, uf,
  count(*) as contratos,
  round(sum(valor_mensal), 2) as receita_contratada,
  round(sum(valor_mensal) / nullif(count(*) filter (where not nao_faturado), 0), 2) as arpu,
  round(100.0 * count(*) / sum(count(*)) over (), 2) as participacao_pct
from ativos
group by 1, 2
order by contratos desc`,
    },
    {
      slug: 'ouro_base_ativa_por_bairro', domain: 'base',
      name: 'Base ativa por bairro (hoje)',
      description: 'Contratos ativos hoje por cidade e bairro, com receita contratada. Denominador para taxas por bairro.',
      sql: `select coalesce(cidade, 'Sem cidade') as cidade, uf, coalesce(bairro, 'Sem bairro') as bairro,
  count(*) as contratos,
  round(sum(valor_mensal), 2) as receita_contratada
from prata_voalle_contratos c
where c.instalado and c.cancelado_em is null
group by 1, 2, 3
order by contratos desc`,
    },
    {
      slug: 'ouro_base_ativa_por_tipo_contrato', domain: 'base',
      name: 'Base ativa por tipo de contrato (hoje)',
      description: 'Contratos ativos hoje por tipo (PF, PJ, cortesia, forma de cobrança), com receita contratada e ARPU.',
      sql: `select coalesce(tipo, 'Sem tipo') as tipo, pessoa,
  count(*) as contratos,
  round(sum(valor_mensal), 2) as receita_contratada,
  round(avg(valor_mensal) filter (where not nao_faturado), 2) as arpu
from prata_voalle_contratos c
where c.instalado and c.cancelado_em is null
group by 1, 2
order by contratos desc`,
    },
    {
      slug: 'ouro_base_ativa_por_faixa_valor', domain: 'base',
      name: 'Base ativa por faixa de valor (hoje)',
      description: 'Distribuição dos contratos ativos por faixa de valor mensal, com receita e participação.',
      sql: `select ${FAIXA_VALOR} as faixa_valor,
  count(*) as contratos,
  round(sum(c.valor_mensal), 2) as receita_contratada,
  round(100.0 * count(*) / sum(count(*)) over (), 2) as participacao_pct
from prata_voalle_contratos c
where c.instalado and c.cancelado_em is null
group by 1
order by 1`,
    },
    {
      slug: 'ouro_base_ativa_por_tempo_de_casa', domain: 'base',
      name: 'Base ativa por tempo de casa (hoje)',
      description: 'Contratos ativos hoje por tempo desde a instalação, com receita e participação.',
      sql: `select ${FAIXA_CASA} as tempo_de_casa,
  count(*) as contratos,
  round(sum(c.valor_mensal), 2) as receita_contratada,
  round(100.0 * count(*) / sum(count(*)) over (), 2) as participacao_pct
from prata_voalle_contratos c
where c.instalado and c.cancelado_em is null
group by 1
order by 1`,
    },
    {
      slug: 'ouro_vendas_conversao_mensal', domain: 'base',
      name: 'Vendas e conversão em instalação por mês',
      description: 'Contratos vendidos em cada mês e o destino deles: instalados, cancelados antes de instalar e ainda em aberto; conversão e dias até instalar.',
      sql: `select cast(date_trunc('month', vendido_em) as date) as mes_venda,
  count(*) as vendas,
  count(*) filter (where instalado) as instaladas,
  count(*) filter (where not instalado and cancelado_em is not null) as canceladas_antes_de_instalar,
  count(*) filter (where not instalado and cancelado_em is null) as em_aberto,
  round(100.0 * count(*) filter (where instalado) / nullif(count(*), 0), 2) as conversao_pct,
  median(date_diff('day', vendido_em, instalado_em)) filter (where instalado) as dias_mediana_ate_instalar
from prata_voalle_contratos
where vendido_em >= date '${DESDE}'
group by 1
order by 1`,
    },
    {
      slug: 'ouro_base_multicontrato', domain: 'base',
      name: 'Clientes com mais de um contrato ativo',
      description: 'Quantos clientes têm 1, 2, 3 ou 4+ contratos ativos hoje, e quanto da base e da receita está em cada grupo.',
      sql: `with por_cliente as (
    select cliente_id, count(*) as contratos, sum(valor_mensal) as receita
      from prata_voalle_contratos c
     where c.instalado and c.cancelado_em is null
     group by cliente_id
  )
select case when contratos >= 4 then '4 ou mais' else cast(contratos as varchar) end as contratos_por_cliente,
  count(*) as clientes,
  sum(contratos) as contratos,
  round(sum(receita), 2) as receita_contratada,
  round(100.0 * sum(contratos) / sum(sum(contratos)) over (), 2) as participacao_contratos_pct
from por_cliente
group by 1
order by 1`,
    },

    // ── Cancelamento ────────────────────────────────────────────────────
    {
      slug: 'ouro_cancelamento_mensal', domain: 'cancelamento',
      name: 'Cancelamento mensal (taxa oficial)',
      description: 'Cancelamentos de contratos instalados por mês (sem lote e duplicado) ÷ base ativa no fim do mês anterior. Também: receita cancelada, lote e vendas que cancelaram antes de instalar.',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM},
  base as (select mes, count(*) as base_fim from ativos_no_fim group by mes),
  canc as (select cast(date_trunc('month', c.cancelado_em) as date) as mes,
                  count(*) filter (where ${CHURN}) as cancelamentos,
                  sum(c.valor_mensal) filter (where ${CHURN}) as receita_cancelada,
                  count(*) filter (where c.cancelado_em_lote) as cancelamentos_em_lote,
                  count(*) filter (where not c.instalado) as canceladas_antes_de_instalar
             from prata_voalle_contratos c where c.cancelado_em is not null group by 1)
select m.mes,
  lag(b.base_fim) over (order by m.mes) as base_inicio,
  coalesce(k.cancelamentos, 0) as cancelamentos,
  round(100.0 * coalesce(k.cancelamentos, 0) / nullif(lag(b.base_fim) over (order by m.mes), 0), 3) as taxa_cancelamento_pct,
  round(coalesce(k.receita_cancelada, 0), 2) as receita_cancelada,
  coalesce(k.cancelamentos_em_lote, 0) as cancelamentos_em_lote,
  coalesce(k.canceladas_antes_de_instalar, 0) as canceladas_antes_de_instalar
from meses m
left join base b on b.mes = m.mes
left join canc k on k.mes = m.mes
order by m.mes`,
    },
    {
      slug: 'ouro_cancelamento_mensal_por_motivo', domain: 'cancelamento',
      name: 'Cancelamento mensal por motivo',
      description: 'Cancelamentos de contratos instalados por mês, grupo de motivo e motivo, com receita cancelada. O motivo é digitado pelo atendente: compare tendências, não confie no rótulo de um caso.',
      sql: `select cast(date_trunc('month', c.cancelado_em) as date) as mes,
  c.motivo_grupo, coalesce(c.motivo, 'Sem motivo registrado') as motivo,
  count(*) as cancelamentos,
  round(sum(c.valor_mensal), 2) as receita_cancelada,
  median(c.dias_de_casa) as dias_de_casa_mediana
from prata_voalle_contratos c
where c.instalado and c.cancelado_em >= date '${DESDE}'
group by 1, 2, 3
order by 1, 4 desc`,
    },
    {
      slug: 'ouro_cancelamento_retencao_por_safra', domain: 'cancelamento',
      name: 'Retenção por safra de instalação',
      description: 'Para cada mês de instalação (safra), quantos contratos seguem ativos 1, 2, … 24 meses depois — a curva de retenção. Lote e duplicado não contam como saída.',
      sql: `with safras as (
    select cast(date_trunc('month', c.instalado_em) as date) as safra, c.instalado_em,
           case when ${CHURN} then c.cancelado_em end as saiu_em
      from prata_voalle_contratos c
     where c.instalado and c.instalado_em >= date '${DESDE}' and not c.cancelado_em_lote
  ), meses as (select cast(k as integer) as meses_de_casa from range(0, 25) as r(k))
select s.safra, m.meses_de_casa,
  count(*) as contratos_na_safra,
  count(*) filter (where s.saiu_em is null or s.saiu_em > cast(s.safra + to_months(m.meses_de_casa + 1) - interval 1 day as date)) as ativos,
  round(100.0 * count(*) filter (where s.saiu_em is null or s.saiu_em > cast(s.safra + to_months(m.meses_de_casa + 1) - interval 1 day as date)) / count(*), 2) as retencao_pct
from safras s cross join meses m
where cast(s.safra + to_months(m.meses_de_casa) as date) <= current_date
group by 1, 2
order by 1, 2`,
    },
    {
      slug: 'ouro_cancelamento_por_tempo_de_casa', domain: 'cancelamento',
      name: 'Cancelamento por tempo de casa',
      description: 'Cancelamentos de contratos instalados por mês e faixa de tempo de casa, separando inadimplência das saídas voluntárias.',
      sql: `select cast(date_trunc('month', c.cancelado_em) as date) as mes,
  ${FAIXA_CASA} as tempo_de_casa,
  count(*) as cancelamentos,
  count(*) filter (where c.motivo_grupo = 'Inadimplência') as por_inadimplencia,
  count(*) filter (where c.motivo_grupo <> 'Inadimplência') as outros_motivos
from prata_voalle_contratos c
where ${CHURN} and c.cancelado_em >= date '${DESDE}'
group by 1, 2
order by 1, 2`,
    },
    {
      slug: 'ouro_cancelamento_por_cidade_12m', domain: 'cancelamento',
      name: 'Cancelamento por cidade (12 meses)',
      description: 'Por cidade: base ativa média dos últimos 12 meses fechados, cancelamentos no período e taxa mensal média.',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM},
  janela as (select mes, fim from meses where mes >= cast(date_trunc('month', current_date) - interval 12 month as date)
                                        and mes < cast(date_trunc('month', current_date) as date)),
  base as (select coalesce(a.cidade, 'Sem cidade') as cidade, count(*) / 12.0 as base_media
             from ativos_no_fim a join janela j on j.mes = a.mes group by 1),
  canc as (select coalesce(c.cidade, 'Sem cidade') as cidade, count(*) as cancelamentos
             from prata_voalle_contratos c
            where ${CHURN} and c.cancelado_em >= (select min(mes) from janela) and c.cancelado_em <= (select max(fim) from janela)
            group by 1)
select b.cidade, round(b.base_media, 1) as base_media,
  coalesce(k.cancelamentos, 0) as cancelamentos_12m,
  round(100.0 * coalesce(k.cancelamentos, 0) / 12 / nullif(b.base_media, 0), 3) as taxa_mensal_media_pct
from base b left join canc k on k.cidade = b.cidade
order by b.base_media desc`,
    },
    {
      slug: 'ouro_cancelamento_por_tipo_contrato_12m', domain: 'cancelamento',
      name: 'Cancelamento por tipo de contrato (12 meses)',
      description: 'Por tipo de contrato: base ativa média dos últimos 12 meses fechados, cancelamentos e taxa mensal média.',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM},
  janela as (select mes, fim from meses where mes >= cast(date_trunc('month', current_date) - interval 12 month as date)
                                        and mes < cast(date_trunc('month', current_date) as date)),
  base as (select coalesce(a.tipo, 'Sem tipo') as tipo, count(*) / 12.0 as base_media
             from ativos_no_fim a join janela j on j.mes = a.mes group by 1),
  canc as (select coalesce(c.tipo, 'Sem tipo') as tipo, count(*) as cancelamentos
             from prata_voalle_contratos c
            where ${CHURN} and c.cancelado_em >= (select min(mes) from janela) and c.cancelado_em <= (select max(fim) from janela)
            group by 1)
select b.tipo, round(b.base_media, 1) as base_media,
  coalesce(k.cancelamentos, 0) as cancelamentos_12m,
  round(100.0 * coalesce(k.cancelamentos, 0) / 12 / nullif(b.base_media, 0), 3) as taxa_mensal_media_pct
from base b left join canc k on k.tipo = b.tipo
order by b.base_media desc`,
    },
    {
      slug: 'ouro_cancelamento_por_faixa_valor_12m', domain: 'cancelamento',
      name: 'Cancelamento por faixa de valor (12 meses)',
      description: 'Por faixa de valor mensal: base ativa média dos últimos 12 meses fechados, cancelamentos e taxa mensal média.',
      sql: `with ${MESES}, ${ATIVOS_NO_FIM},
  janela as (select mes, fim from meses where mes >= cast(date_trunc('month', current_date) - interval 12 month as date)
                                        and mes < cast(date_trunc('month', current_date) as date)),
  base as (select ${FAIXA_VALOR.replace(/c\./g, 'a.')} as faixa_valor, count(*) / 12.0 as base_media
             from ativos_no_fim a join janela j on j.mes = a.mes group by 1),
  canc as (select ${FAIXA_VALOR} as faixa_valor, count(*) as cancelamentos
             from prata_voalle_contratos c
            where ${CHURN} and c.cancelado_em >= (select min(mes) from janela) and c.cancelado_em <= (select max(fim) from janela)
            group by 1)
select b.faixa_valor, round(b.base_media, 1) as base_media,
  coalesce(k.cancelamentos, 0) as cancelamentos_12m,
  round(100.0 * coalesce(k.cancelamentos, 0) / 12 / nullif(b.base_media, 0), 3) as taxa_mensal_media_pct
from base b left join canc k on k.faixa_valor = b.faixa_valor
order by b.faixa_valor`,
    },
    {
      slug: 'ouro_cancelamento_nao_instalados_mensal', domain: 'cancelamento',
      name: 'Vendas canceladas antes de instalar, por mês e motivo',
      description: 'Contratos que cancelaram sem nunca ter sido instalados (falta de contato, endereço com pendência, desistência, inviabilidade…), por mês de cancelamento.',
      sql: `select cast(date_trunc('month', c.cancelado_em) as date) as mes,
  coalesce(c.motivo, 'Sem motivo registrado') as motivo,
  count(*) as cancelamentos,
  median(date_diff('day', c.vendido_em, c.cancelado_em)) as dias_mediana_venda_ate_cancelar
from prata_voalle_contratos c
where not c.instalado and c.cancelado_em >= date '${DESDE}'
  and coalesce(c.motivo_codigo, '') <> 'OTR.CAN.006'
group by 1, 2
order by 1, 3 desc`,
    },

    // ── Financeiro ──────────────────────────────────────────────────────
    {
      slug: 'ouro_financeiro_faturamento_mensal', domain: 'financeiro',
      name: 'Faturamento por mês de vencimento',
      description: 'Faturas por mês de vencimento até o mês corrente: quantidade, contratos faturados, valor total, valor de serviço de comunicação (SCM) e ticket médio. Só a fatura que o cliente recebe.',
      sql: `select cast(date_trunc('month', vence_em) as date) as mes_vencimento,
  count(*) as faturas,
  count(distinct contrato_id) as contratos_faturados,
  round(sum(valor), 2) as valor_faturado,
  round(sum(valor) filter (where natureza = 'RS - RECEITAS SERVIÇOS COMUNICAÇÃO SCM'), 2) as valor_servico_scm,
  round(sum(valor) filter (where natureza like 'RP - VENDA%'), 2) as valor_venda_equipamento,
  round(avg(valor), 2) as ticket_medio
from prata_voalle_faturas
where not renegociada and vence_em < cast(date_trunc('month', current_date) + interval 1 month as date)
group by 1
order by 1`,
    },
    {
      slug: 'ouro_financeiro_recebimento_mensal', domain: 'financeiro',
      name: 'Recebimento por mês de pagamento',
      description: 'Faturas pagas por mês de pagamento: quantidade, valor recebido e quanto foi pago até o vencimento.',
      sql: `select cast(date_trunc('month', paga_em) as date) as mes_pagamento,
  count(*) as faturas_pagas,
  round(sum(valor_recebido), 2) as valor_recebido,
  round(100.0 * count(*) filter (where dias_pagamento_apos_vencimento <= 0) / count(*), 2) as pagas_ate_vencimento_pct
from prata_voalle_faturas
where paga and paga_em is not null
group by 1
order by 1`,
    },
    {
      slug: 'ouro_financeiro_recebimento_por_forma', domain: 'financeiro',
      name: 'Recebimento por forma de pagamento',
      description: 'Faturas pagas por mês e forma de pagamento (Pix, boleto, cartão…), com valor e participação no mês.',
      sql: `select cast(date_trunc('month', paga_em) as date) as mes_pagamento,
  coalesce(forma_pagamento, 'Não informada') as forma_pagamento,
  count(*) as faturas,
  round(sum(valor_recebido), 2) as valor_recebido,
  round(100.0 * count(*) / sum(count(*)) over (partition by cast(date_trunc('month', paga_em) as date)), 2) as participacao_pct
from prata_voalle_faturas
where paga and paga_em is not null
group by 1, 2
order by 1, 3 desc`,
    },
    {
      slug: 'ouro_financeiro_aging_atual', domain: 'financeiro',
      name: 'Contas a receber por idade (aging, hoje)',
      description: 'Saldo em aberto hoje por faixa de atraso (a vencer em 30 dias, a vencer depois — parcelas futuras de planos anuais —, 1–30, 31–60, 61–90, 91–180, 181–365, mais de 1 ano), com faturas e contratos.',
      sql: `select case
    when dias_em_atraso = 0 and vence_em <= current_date + interval 30 day then '0a · a vencer em até 30 dias'
    when dias_em_atraso = 0 then '0b · a vencer depois de 30 dias'
    when dias_em_atraso <= 30 then '1 · 1 a 30 dias'
    when dias_em_atraso <= 60 then '2 · 31 a 60 dias'
    when dias_em_atraso <= 90 then '3 · 61 a 90 dias'
    when dias_em_atraso <= 180 then '4 · 91 a 180 dias'
    when dias_em_atraso <= 365 then '5 · 181 a 365 dias'
    else '6 · mais de 1 ano' end as faixa_atraso,
  count(*) as faturas,
  count(distinct contrato_id) as contratos,
  round(sum(saldo), 2) as saldo_em_aberto,
  round(100.0 * sum(saldo) / sum(sum(saldo)) over (), 2) as participacao_pct
from prata_voalle_faturas
where saldo > 0 and not renegociada
group by 1
order by 1`,
    },
    {
      slug: 'ouro_financeiro_inadimplencia_por_vencimento', domain: 'financeiro',
      name: 'Inadimplência por mês de vencimento',
      description: 'Para as faturas de cada mês de vencimento: valor faturado, quanto segue em aberto hoje (e quanto disso é de contrato já cancelado), inadimplência (em aberto há mais de 30 e 90 dias ÷ faturado) e quanto foi pago no prazo ou com atraso.',
      sql: `select cast(date_trunc('month', f.vence_em) as date) as mes_vencimento,
  count(*) as faturas,
  round(sum(f.valor), 2) as valor_faturado,
  round(sum(f.saldo), 2) as em_aberto_hoje,
  round(sum(f.saldo) filter (where c.cancelado_em is not null), 2) as em_aberto_de_contratos_cancelados,
  round(100.0 * sum(f.saldo) filter (where f.dias_em_atraso > 30) / nullif(sum(f.valor), 0), 3) as inadimplencia_30d_pct,
  round(100.0 * sum(f.saldo) filter (where f.dias_em_atraso > 90) / nullif(sum(f.valor), 0), 3) as inadimplencia_90d_pct,
  round(100.0 * count(*) filter (where f.paga and f.dias_pagamento_apos_vencimento <= 0) / count(*), 2) as pagas_no_prazo_pct,
  round(100.0 * count(*) filter (where f.paga and f.dias_pagamento_apos_vencimento > 0) / count(*), 2) as pagas_com_atraso_pct
from prata_voalle_faturas f
left join prata_voalle_contratos c on c.contrato_id = f.contrato_id
where not f.renegociada and f.vence_em <= current_date
group by 1
order by 1`,
    },
    {
      slug: 'ouro_financeiro_prazo_de_pagamento_mensal', domain: 'financeiro',
      name: 'Prazo de pagamento por mês de vencimento',
      description: 'Faturas pagas por faixa de dias entre o vencimento e o pagamento (antecipado, no dia, D+1 a 5, 6 a 15, 16 a 30, 31 a 60, mais de 60).',
      sql: `select cast(date_trunc('month', vence_em) as date) as mes_vencimento,
  case
    when dias_pagamento_apos_vencimento < 0 then '0 · antecipado'
    when dias_pagamento_apos_vencimento = 0 then '1 · no vencimento'
    when dias_pagamento_apos_vencimento <= 5 then '2 · D+1 a 5'
    when dias_pagamento_apos_vencimento <= 15 then '3 · D+6 a 15'
    when dias_pagamento_apos_vencimento <= 30 then '4 · D+16 a 30'
    when dias_pagamento_apos_vencimento <= 60 then '5 · D+31 a 60'
    else '6 · mais de 60 dias' end as prazo_pagamento,
  count(*) as faturas,
  round(sum(valor_recebido), 2) as valor_recebido
from prata_voalle_faturas
where paga and dias_pagamento_apos_vencimento is not null
group by 1, 2
order by 1, 2`,
    },
    {
      slug: 'ouro_financeiro_inadimplencia_por_cidade', domain: 'financeiro',
      name: 'Inadimplência por cidade (hoje)',
      description: 'Por cidade: contratos ativos, contratos com fatura em aberto há mais de 30 dias, saldo vencido e percentual da base.',
      sql: `with atraso as (
    select contrato_id, sum(saldo) as saldo_vencido
      from prata_voalle_faturas
     where saldo > 0 and not renegociada and dias_em_atraso > 30
     group by contrato_id
  )
select coalesce(c.cidade, 'Sem cidade') as cidade, c.uf,
  count(*) as contratos_ativos,
  count(a.contrato_id) as contratos_em_atraso_30d,
  round(coalesce(sum(a.saldo_vencido), 0), 2) as saldo_vencido_30d,
  round(100.0 * count(a.contrato_id) / count(*), 2) as contratos_em_atraso_pct
from prata_voalle_contratos c
left join atraso a on a.contrato_id = c.contrato_id
where c.instalado and c.cancelado_em is null
group by 1, 2
order by contratos_ativos desc`,
    },
    {
      slug: 'ouro_financeiro_contratos_em_atraso', domain: 'financeiro',
      name: 'Contratos com fatura em atraso (lista de cobrança)',
      description: 'Um contrato por linha com fatura vencida e em aberto: faturas vencidas, saldo, maior atraso, valor mensal, cidade e se o contrato ainda está ativo. Identificação só por número.',
      sql: `with atraso as (
    select contrato_id, count(*) as faturas_vencidas, sum(saldo) as saldo_vencido,
           max(dias_em_atraso) as maior_atraso_dias, min(vence_em) as vencimento_mais_antigo
      from prata_voalle_faturas
     where saldo > 0 and not renegociada and dias_em_atraso > 0
     group by contrato_id
  )
select a.contrato_id, c.contrato_numero, c.cliente_id, c.tipo, c.pessoa, c.cidade, c.bairro,
  c.cancelado_em is null as contrato_ativo,
  c.valor_mensal,
  a.faturas_vencidas,
  round(a.saldo_vencido, 2) as saldo_vencido,
  a.maior_atraso_dias,
  a.vencimento_mais_antigo,
  case
    when a.maior_atraso_dias <= 15 then '1 · até 15 dias'
    when a.maior_atraso_dias <= 30 then '2 · 16 a 30 dias'
    when a.maior_atraso_dias <= 60 then '3 · 31 a 60 dias'
    when a.maior_atraso_dias <= 90 then '4 · 61 a 90 dias'
    else '5 · mais de 90 dias' end as faixa_atraso
from atraso a
left join prata_voalle_contratos c on c.contrato_id = a.contrato_id
order by a.saldo_vencido desc`,
    },
    {
      slug: 'ouro_financeiro_renegociacao_mensal', domain: 'financeiro',
      name: 'Faturas renegociadas por mês de vencimento',
      description: 'Faturas que foram renegociadas (o saldo passou para títulos novos), por mês de vencimento original: quantidade, contratos e valor.',
      sql: `select cast(date_trunc('month', vence_em) as date) as mes_vencimento,
  count(*) as faturas_renegociadas,
  count(distinct contrato_id) as contratos,
  round(sum(valor), 2) as valor_renegociado
from prata_voalle_faturas
where renegociada
group by 1
order by 1`,
    },
  ],

  // Análises prontas (SQL + Python) sobre os conjuntos acima — ver onda1Notebooks.ts.
  notebooks: NOTEBOOKS_ONDA_1,
}
