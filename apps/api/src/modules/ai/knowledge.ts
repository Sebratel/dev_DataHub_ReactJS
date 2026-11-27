// ─────────────────────────────────────────────────────────────────────────
// O que o assistente SABE do negócio antes de abrir um conjunto (27/11/2026).
//
// O assistente falhava menos por raciocínio e mais por não saber o que um
// analista da casa sabe: que a fatura do Voalle vem em dobro, que instalado é
// stage 3, que cancelamento em lote não é churn, que o motivo é digitado. Sem
// isso ele soma o que não deve e responde com confiança.
//
// O conhecimento tem quatro camadas, da mais geral para a mais específica, e
// TODAS valem sozinhas para um conjunto novo:
//   1. REGRAS_GERAIS — vão no prompt de toda pergunta.
//   2. Por TABELA DE ORIGEM (schema.tabela, ex. erp.contracts) — vale para
//      qualquer conjunto que copie aquela tabela, com o nome que tiver. Um
//      conjunto publicado amanhã a partir de erp.contracts já nasce sabendo.
//   3. Por CONJUNTO dos pacotes (prata_/ouro_) — descrição do pacote, notas de
//      campo e, para todo calculado, o próprio SQL (lido do catálogo).
//   4. Notas da equipe (ai_dataset_notes) — o que alguém ensinou pela tela.
// Por cima disso, o PERFIL automático (profile.ts): valores, nulos e faixas,
// lidos do Parquet na primeira vez que o assistente abre o conjunto.
//
// Fonte das regras: os pacotes (catalog/packs/onda1.ts e onda2.ts), as análises
// do Health Score e do churn, e os dicionários conferidos no SRD em 27/11/2026.
// ─────────────────────────────────────────────────────────────────────────
import { PACKS } from '../catalog/packs.js'

export const REGRAS_GERAIS = `Regras do negócio (Sebratel, provedor de internet por fibra no RS; ERP = Voalle):
- A UNIDADE é o CONTRATO, não o cliente: uma pessoa pode ter vários contratos. "Clientes ativos" quase sempre quer dizer contratos ativos; se a pergunta for por pessoa, conte cliente_id distinto e diga que fez isso.
- Instalado (visão comercial) = etapa (stage) 3 com approval_date preenchida; approval_date é o dia da instalação. Contrato cancelado em outra etapa nunca foi instalado: é venda que morreu, não cliente que saiu.
- Instalado (visão de campo) = material alocado no protocolo (patrimony_packing_list_items.out_date). Cai no mesmo dia da primeira conexão em 99,7% dos casos. As duas visões diferem um pouco; diga qual usou.
- Ativo numa data D = instalado até D e sem cancelamento até D. Fora sempre: telefonia (tipo 19) e linhas apagadas (deleted = true).
- Taxa de cancelamento oficial = cancelamentos do mês ÷ base ativa no fim do mês ANTERIOR. Não contam como churn: venda de operação em lote (FNC.CAN.020) e contrato duplicado (OTR.CAN.006).
- Cortesia (tipo 3) e adequação de condomínio (tipo 36) ficam na base com receita zero.
- Receita contratada = contracts.amount (valor mensal). ARPU = receita ÷ contratos faturados.
- FATURA: cada mês tem DOIS títulos de mesmo valor — a fatura que o cliente recebe (bill_title_id vazio) e os componentes que apontam para ela. Somar os dois DOBRA a receita e as baixas: use só bill_title_id nulo. Tarifa de baixa de título não é receita. Plano anual gera as 12 parcelas de uma vez (títulos a vencer no futuro).
- Fatura renegociada sai do atraso: o saldo dela foi para títulos novos.
- O motivo de cancelamento é digitado pelo atendente e mede também o hábito de quem digita (mudança de endereço varia 32x entre atendentes): compare tendência e participação, nunca afirme a causa de um caso.
- Datas "1000-01-01" são o nulo do Voalle. O mês corrente é PARCIAL: compare com o mesmo período ou avise.
- No lake os números das fontes vêm como DOUBLE (o id 123 aparece 123.0): use cast(x as bigint) para juntar ou mostrar ids.`

export interface TabelaConhecimento {
  /** Para que a tabela serve. */
  resumo: string
  /** O que UMA linha é. */
  grao: string
  armadilhas?: string[]
  /** Nota por coluna (nome da coluna na origem). */
  campos?: Record<string, string>
}

// Chave: schema.tabela da origem; para fontes sem schema útil (MariaDB), só a
// tabela. A busca tenta as duas (conhecimentoDaTabela).
export const CONHECIMENTO_TABELAS: Record<string, TabelaConhecimento> = {
  'erp.contracts': {
    resumo: 'Contratos de internet (e telefonia) do Voalle — base de clientes, vendas, instalações e cancelamentos.',
    grao: 'Um contrato. Uma pessoa (client_id) pode ter vários.',
    armadilhas: [
      'Telefonia (contract_type_id 19) e deleted = true ficam fora de qualquer indicador de base. Os tipos 9 e 11 (telefonia de empresas incorporadas) e 10 (cortesia) não têm contrato ativo (conferido em 27/11/2026).',
      'created "1000-01-01" é o nulo do Voalle (venda sem data).',
      'status 4 = cancelado (sempre com cancellation_date). Os outros status (1 vigente; 3, 5, 6, 7, 9 bloqueios e suspensões) com stage 3 e sem cancellation_date contam como ATIVOS pela regra oficial.',
      'Use cancellation_date para saber se e quando cancelou; o status sozinho não dá a data.',
    ],
    campos: {
      id: 'Id do contrato (junta com financial_receivable_titles.contract_id, contract_events.contract_id).',
      contract_number: 'Número do contrato que a operação usa.',
      client_id: 'Pessoa dona do contrato (erp.people.id).',
      contract_type_id: 'Tipo (erp.contract_types). Mais comuns: 27 PF mensal e-mail, 28 PF anual correio, 38 PF anual digital, 21 PF Sebratel, 30 PF anual e-mail, 2 Serrana PF. Telefonia: 19. Cortesia: 3. Condomínio: 36.',
      status: '1 vigente, 4 cancelado; 3, 5, 6, 7, 9 são bloqueio/suspensão (contrato instalado e não cancelado).',
      stage: '3 = aprovado (instalado, com approval_date); 5 = cancelado antes de instalar; 2 = em andamento; 1 = pré-contrato recente.',
      created: 'Data da venda.',
      approval_date: 'Data da instalação (quando stage = 3).',
      cancellation_date: 'Data do cancelamento; vazia = não cancelado.',
      amount: 'Valor mensal contratado (receita contratada).',
      people_address_id: 'Endereço de instalação (erp.people_addresses).',
    },
  },
  'erp.contract_types': {
    resumo: 'Tipos de contrato: PF/PJ, empresa de origem (Sebratel, Serrana, Rede Brasil, SEB), periodicidade e forma de cobrança.',
    grao: 'Um tipo de contrato.',
    armadilhas: ['Telefonia: 19 (9 e 11 só com contratos antigos). Cortesia: 3. Adequação de condomínio: 36. "PJ - Conversão (Não Utilizar)" é o 1.'],
  },
  'erp.contract_events': {
    resumo: 'Eventos de contrato (cancelamento, alteração de vencimento, upgrade…). O cancelamento traz o motivo.',
    grao: 'Um evento de um contrato.',
    armadilhas: [
      'O motivo do cancelamento = o código do ÚLTIMO evento de cancelamento do contrato (contract_event_types.code com ".CAN.").',
      'Filtre deleted = false.',
    ],
    campos: { contract_event_type_id: 'Tipo do evento (erp.contract_event_types).', date: 'Data do evento.' },
  },
  'erp.contract_event_types': {
    resumo: 'Dicionário dos eventos de contrato. Os de cancelamento têm ".CAN." no código.',
    grao: 'Um tipo de evento.',
    campos: {
      code: 'Cancelamentos: IND.CAN.001 inadimplência, IND.CAN.021 inadimplência sem mensalidade paga, MDE.CAN.008 mudança de endereço, CNC.CAN.013 concorrência, INS.CAN.004 insatisfação, FNC.CAN.007 dificuldade financeira, OTR.CAN.002 não utiliza mais, OTR.CAN.009 falecimento, FNC.CAN.020 lote (venda de operação), OTR.CAN.006 duplicado; os "Cliente Não Instalado" (FNC.CAN.016/017/019, NIN.CAN.005, OTR.CAN.012/014/015/018/022/023) são vendas que não chegaram a instalar.',
    },
  },
  'erp.people': {
    resumo: 'Cadastro de pessoas (clientes, colaboradores, fornecedores).',
    grao: 'Uma pessoa.',
    armadilhas: ['Nome e documento são dados pessoais: não traga.', 'Nem toda pessoa é cliente: cliente é quem tem contrato.'],
    campos: { type_tx_id: '2 = pessoa física (PF), 1 = pessoa jurídica (PJ), 3 = outros (raro).', city: 'Cidade do cadastro (o endereço de instalação vem de people_addresses e é preferível).' },
  },
  'erp.people_addresses': {
    resumo: 'Endereços das pessoas; o do contrato (contracts.people_address_id) é o de instalação.',
    grao: 'Um endereço.',
    armadilhas: ['Cidade escrita à mão: pode haver variações de grafia; compare sem acento e sem caixa.'],
  },
  'erp.financial_receivable_titles': {
    resumo: 'Títulos a receber: faturas, componentes de fatura e parcelas (inclusive as futuras de planos anuais).',
    grao: 'Um título. Uma fatura do cliente = 1 título com bill_title_id vazio + componentes que apontam para ele.',
    armadilhas: [
      'SOMAR TUDO DOBRA A RECEITA: a fatura e os componentes têm o mesmo valor. Use só bill_title_id nulo.',
      'Tarifa de baixa de título (natureza "DF - TARIFA BAIXA DE TÍTULO") não é receita.',
      'Plano anual gera 12 parcelas de uma vez: títulos com vencimento futuro não são atraso.',
      'renegotiated = true: o saldo foi para títulos novos; não conte como inadimplência.',
      'balance = saldo em aberto; vencido = balance > 0 e expiration_date < hoje.',
    ],
    campos: {
      bill_title_id: 'Vazio = é a fatura que o cliente recebe; preenchido = componente da fatura indicada.',
      title_amount: 'Valor do título.',
      balance: 'Saldo em aberto (0 = pago ou baixado).',
      expiration_date: 'Vencimento.',
      competence: 'Mês de competência.',
      financer_nature_id: 'Natureza (erp.financers_natures). A de internet é "RS - RECEITAS SERVIÇOS COMUNICAÇÃO SCM".',
    },
  },
  'erp.financial_receipt_titles': {
    resumo: 'Baixas (recebimentos) dos títulos a receber.',
    grao: 'Uma baixa de um título; um título pode ter mais de uma.',
    armadilhas: [
      'Componentes também recebem baixa: some baixas só de títulos com bill_title_id nulo, ou dobra o recebido.',
      'Data do pagamento = coalesce(client_paid_date, receipt_date).',
    ],
    campos: { payment_form_id: 'Forma (erp.payment_forms): 10 Pix, 9 PixVoalle, 7 Boleto, 5 Cartão Crédito, 4 Cartão Débito, 1 Dinheiro, 8 Débito.' },
  },
  'erp.financers_natures': {
    resumo: 'Natureza financeira de cada título (receita de SCM, telefonia, venda de equipamento, tarifas…).',
    grao: 'Uma natureza.',
  },
  'erp.payment_forms': {
    resumo: 'Formas de pagamento: Pix, PixVoalle, Boleto, cartão, dinheiro, débito.',
    grao: 'Uma forma de pagamento.',
  },
  'erp.assignments': {
    resumo: 'Atendimentos (cabeçalho): abertura, conclusão e solicitante. O detalhe do protocolo (tipo, status, equipe) está em assignment_incidents.',
    grao: 'Um atendimento.',
    armadilhas: [
      'Tabela muito grande; filtre por created.',
      'requestor_id = pessoa solicitante (cliente). Colaborador que abre protocolo como cliente aparece aqui também (~5 por ano).',
      'Tempo até concluir = conclusion_date − created.',
    ],
  },
  'erp.assignment_incidents': {
    resumo: 'Protocolos: tipo, status, equipe, catálogo e serviço de cada atendimento.',
    grao: 'Um protocolo (assignment_id liga ao atendimento).',
    armadilhas: [
      'Sem data de alteração no Voalle: a cópia é completa.',
      'Status (incident_status): 1 Abertura, 2 Andamento, 4 Encerrado, 8 Cancelado, 35 A Faturar, 36 Faturado; encerrado = Encerrado, A Faturar ou Faturado.',
    ],
    campos: {
      incident_type_id: 'Tipo (erp.incident_types). Ativação: 12, 1014, 1297, 1254, 1255, 1136, 249, 1015. Movimentação: 268, 279, 15, 1298, 1256. Retorno por problema: 1267, 1174, 1253, 1160, 1270.',
      team_id: 'Equipe (erp.teams). Manutenção: 1050, 65, 1065, 1064, 1063, 1062 (vale até abr/2025; depois use o catálogo).',
      catalog_service_id: 'Catálogo (erp.catalog_services). Manutenção a partir de jun/2025: Oper. Reparo, Oper. Tecnologia, Equipe tecnologia, Equipe reparo.',
    },
  },
  'erp.incident_types': { resumo: 'Dicionário dos tipos de protocolo (código e nome).', grao: 'Um tipo de protocolo.' },
  'erp.incident_status': {
    resumo: 'Dicionário dos status de protocolo.',
    grao: 'Um status.',
    campos: { title: 'Principais: Abertura, Andamento, Encerrado, Cancelado, A Faturar, Faturado, Agendado, Sem contato, Massiva.' },
  },
  'erp.teams': { resumo: 'Equipes (técnicas, atendimento, comerciais).', grao: 'Uma equipe.' },
  'erp.catalog_services': { resumo: 'Catálogos de serviço dos protocolos (Oper. Reparo, Equipe ativação…).', grao: 'Um catálogo.' },
  'erp.contract_service_tags': {
    resumo: 'Serviços (etiquetas) de cada contrato: liga o protocolo ao contrato.',
    grao: 'Um serviço de um contrato.',
  },
  'erp.patrimony_packing_lists': { resumo: 'Romaneios de material, por atendimento.', grao: 'Um romaneio.' },
  'erp.patrimony_packing_list_items': {
    resumo: 'Itens dos romaneios: saída de cada equipamento.',
    grao: 'Um item (equipamento) de um romaneio.',
    armadilhas: ['out_date preenchida = material alocado = instalação feita (visão de campo).', 'person_allocator_id = técnico que alocou.'],
  },
  'erp.service_desk_slots': {
    resumo: 'Agenda de campo: horários por técnico e região.',
    grao: 'Um horário (slot) da agenda.',
    armadilhas: ['Regiões conhecidas: 23 Base São Leopoldo (Manutenção), 24 Base Canoas (Manutenção), 29 Base Canoas (Ativação), 30 Base São Leopoldo (Ativação).'],
  },
  'erp.fsm_attendance_history': {
    resumo: 'Histórico do app de campo: cada estado do atendimento (deslocamento, execução…).',
    grao: 'Uma mudança de estado de um atendimento no app.',
  },
  'erp.authentication_contracts': {
    resumo: 'Autenticações (logins PPPoE/serviço) de cada contrato.',
    grao: 'Uma autenticação de um serviço de contrato.',
  },
  // Native/Matrix (MariaDB). Ver a memória "Funil da ISA" e o dashboard Native/Matrix.
  db_matrix_atendimento_analitico: {
    resumo: 'Atendimentos do Matrix/Native (WhatsApp, URA, ISA) com tags de classificação.',
    grao: 'Um atendimento.',
    armadilhas: [
      'A coluna tag guarda VÁRIAS tags na mesma célula, no formato "A || B" (com aspas): use list_field_values, que separa sozinho, ou string_split no SQL.',
      'Desde 14/05/2026 as tags têm prefixo ISA_ e maiúsculas (ex.: ISA_DESBLOQUEIO_CONFIANÇA, ISA_SEGUNDA_VIA_BOLETOS); antes eram textos como "Desbloqueio de confiança".',
      'Cerca de 32% dos atendimentos não têm tag.',
    ],
  },
}

export function conhecimentoDaTabela(schema: string | null | undefined, tabela: string | null | undefined): TabelaConhecimento | null {
  if (!tabela) return null
  const t = tabela.toLowerCase()
  if (schema) {
    const k = CONHECIMENTO_TABELAS[`${schema.toLowerCase()}.${t}`]
    if (k) return k
  }
  return CONHECIMENTO_TABELAS[t] ?? null
}

// ── Conjuntos dos pacotes ────────────────────────────────────────────────
// A descrição vem do próprio pacote (uma fonte só). Aqui entram as notas de
// campo e o "quando usar" que a descrição não diz.
export interface ConjuntoConhecimento {
  resumo: string
  grao?: string
  armadilhas?: string[]
  campos?: Record<string, string>
}

const NOTAS_PACOTE: Record<string, Omit<ConjuntoConhecimento, 'resumo'>> = {
  prata_voalle_contratos: {
    grao: 'Um contrato (sem telefonia tipo 19 e sem apagados).',
    armadilhas: [
      'Ativo hoje = instalado and cancelado_em is null.',
      'Churn = instalado, cancelado_em preenchido e motivo_codigo fora de FNC.CAN.020 (lote) e OTR.CAN.006 (duplicado).',
      'valor_mensal já é zero para cortesia e condomínio (nao_faturado = true).',
    ],
    campos: {
      instalado: 'true = etapa 3 com data de instalação.',
      instalado_em: 'Dia da instalação (approval_date).',
      vendido_em: 'Dia da venda.',
      cancelado_em: 'Dia do cancelamento; vazio = não cancelado.',
      motivo_grupo: 'Motivo agrupado: Inadimplência, Mudança de endereço, Concorrência, Insatisfação, Falecimento, Voluntário (outros), Não instalado, Venda de operação (lote), Contrato duplicado, Sem motivo registrado, Outros.',
      pessoa: 'PF, PJ ou outro.',
      dias_de_casa: 'Dias entre a instalação e o cancelamento (ou hoje).',
      status_codigo: '1 vigente, 4 cancelado; outros = bloqueio/suspensão.',
    },
  },
  prata_voalle_faturas: {
    grao: 'Uma fatura do cliente (só bill_title_id nulo — sem dobrar), vencimentos desde 2023.',
    armadilhas: [
      'Inadimplência: saldo > 0, not renegociada e dias_em_atraso > 30 (ou 90).',
      'Faturas a vencer depois de 30 dias são parcelas futuras de planos anuais, não atraso.',
      'valor_recebido soma as baixas; paga = saldo zerado e não renegociada.',
    ],
    campos: {
      vence_em: 'Vencimento.',
      saldo: 'Em aberto hoje.',
      paga_em: 'Dia do pagamento (só para paga = true).',
      dias_em_atraso: 'Dias vencida e em aberto (0 se paga ou a vencer).',
      natureza: 'Internet = "RS - RECEITAS SERVIÇOS COMUNICAÇÃO SCM"; venda de equipamento começa com "RP - VENDA".',
      forma_pagamento: 'Pix, PixVoalle, Boleto, Cartão Crédito…',
    },
  },
  prata_voalle_protocolos_campo: {
    grao: 'Um protocolo de campo desde 2025 (ativação, movimentação, manutenção ou retorno por problema).',
    armadilhas: [
      'grupo = Ativação | Movimentação | Manutenção. Cancelados ficam (cancelado = true): tire quando medir demanda real.',
      'horas_ate_concluir só existe para concluídos.',
    ],
  },
  prata_voalle_instalacoes: {
    grao: 'Uma instalação: protocolo de ativação ou movimentação com material alocado.',
    armadilhas: ['instalado_em = dia da alocação do material (visão de campo).', 'tecnico_id é o id da pessoa que alocou; não há nome no lake.'],
  },
  ouro_base_ativa_mensal: { armadilhas: ['A linha do mês corrente é a base de HOJE; as outras são o último dia do mês.'] },
  ouro_cancelamento_mensal: {
    armadilhas: [
      'taxa_cancelamento_pct é a taxa oficial (÷ base do fim do mês anterior).',
      'O mês corrente é parcial: compare com meses fechados ou projete com cuidado.',
    ],
  },
  ouro_cancelamento_mensal_por_motivo: { armadilhas: ['O motivo é digitado: use participação e tendência, não o caso.'] },
  ouro_financeiro_faturamento_mensal: { armadilhas: ['Por mês de VENCIMENTO. Faturamento por competência não é isto.'] },
  ouro_financeiro_contratos_em_atraso: { armadilhas: ['Identificação só por número de contrato: nada de nome ou documento.'] },
  ouro_campo_reparos_diarios: { armadilhas: ['Meta do coeficiente: 0,12% em dia útil, 0,08% no sábado, 0,06% no domingo.'] },
}

const PACOTE_POR_SLUG = new Map(
  PACKS.flatMap((p) => p.datasets.map((d) => [d.slug, { pacote: p.name, nome: d.name, descricao: d.description, dominio: d.domain }] as const)),
)

export function conhecimentoDoPacote(slug: string): (ConjuntoConhecimento & { pacote: string; dominio: string }) | null {
  const p = PACOTE_POR_SLUG.get(slug)
  if (!p) return null
  return { resumo: p.descricao, pacote: p.pacote, dominio: p.dominio, ...(NOTAS_PACOTE[slug] ?? {}) }
}

/** Os conjuntos dos pacotes, na ordem do catálogo — o mapa que vai no prompt. */
export function mapaDosPacotes(): { slug: string; nome: string; descricao: string; dominio: string }[] {
  return [...PACOTE_POR_SLUG.entries()].map(([slug, p]) => ({ slug, nome: p.nome, descricao: p.descricao, dominio: p.dominio }))
}
