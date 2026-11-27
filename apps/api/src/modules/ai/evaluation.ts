// ─────────────────────────────────────────────────────────────────────────
// Avaliação do assistente (pedido de 27/11/2026: "faça os testes no final").
//
// Perguntas reais de negócio, cada uma com um SQL de REFERÊNCIA sobre os
// conjuntos dos pacotes. O gabarito não é um número fixo: é calculado na hora,
// sobre o mesmo lake que o assistente consulta — o teste continua valendo
// amanhã, com outros dados, e em qualquer ambiente (produção, staging, teste).
//
// Passa quando cada número (ou texto) do gabarito aparece na resposta, dentro
// da tolerância. É de propósito uma régua de RESULTADO, não de caminho: tanto
// faz se ele usou o ouro pronto ou juntou a prata — importa o número certo.
//
// Várias perguntas são armadilhas conhecidas: faturamento (a fatura do Voalle
// vem em dobro), taxa de cancelamento (sem lote, sobre a base do mês
// anterior), base ativa (sem telefonia). Errar uma delas é exatamente o erro
// que fazia a equipe desconfiar do assistente.
//
// Estas perguntas NÃO entram no conhecimento do assistente: vazaria o gabarito.
// ─────────────────────────────────────────────────────────────────────────
import type { SessionUser } from '@datahub/shared'
import { db } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { duckQuery } from '../query/duck.js'
import { lakeRefs, compileNotebookSql, friendlyDuckError } from '../transform/derive.js'
import type { AIProvider } from './provider.js'
import { responder } from './assistant.js'

export type TipoChecagem = 'numero' | 'pct' | 'texto'

export interface Checagem {
  /** Coluna da 1ª linha do SQL de referência. */
  coluna: string
  tipo: TipoChecagem
  /** numero: tolerância RELATIVA (0,01 = 1%); pct: ABSOLUTA em pontos percentuais. */
  tol?: number
}

export interface CasoAvaliacao {
  id: string
  tema: 'base' | 'cancelamento' | 'financeiro' | 'campo' | 'cruzamento'
  pergunta: string
  /** SQL do gabarito (DuckDB, nomes do lake). A 1ª linha é o gabarito. */
  sql: string
  checar: Checagem[]
}

const OUT = "date '2026-10-01'"

export const CASOS: CasoAvaliacao[] = [
  // ── Base ──────────────────────────────────────────────────────────────
  {
    id: 'base-ativos-hoje', tema: 'base',
    pergunta: 'Quantos contratos ativos temos hoje?',
    sql: 'select contratos_ativos from ouro_base_ativa_mensal order by mes desc limit 1',
    checar: [{ coluna: 'contratos_ativos', tipo: 'numero', tol: 0.005 }],
  },
  {
    id: 'base-arpu-hoje', tema: 'base',
    pergunta: 'Qual o ticket médio (ARPU) da base ativa hoje?',
    sql: 'select arpu from ouro_base_ativa_mensal order by mes desc limit 1',
    checar: [{ coluna: 'arpu', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'base-pj-hoje', tema: 'base',
    pergunta: 'Quantos contratos de pessoa jurídica (PJ) estão ativos hoje?',
    sql: 'select contratos_pj from ouro_base_ativa_mensal order by mes desc limit 1',
    checar: [{ coluna: 'contratos_pj', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'base-receita-hoje', tema: 'base',
    pergunta: 'Qual a receita mensal contratada da base ativa hoje?',
    sql: 'select receita_contratada from ouro_base_ativa_mensal order by mes desc limit 1',
    checar: [{ coluna: 'receita_contratada', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'base-maior-cidade', tema: 'base',
    pergunta: 'Qual cidade tem mais contratos ativos hoje, e quantos são?',
    sql: 'select cidade, contratos from ouro_base_ativa_por_cidade order by contratos desc limit 1',
    checar: [{ coluna: 'cidade', tipo: 'texto' }, { coluna: 'contratos', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'base-vendas-instalacoes-out', tema: 'base',
    pergunta: 'Quantas vendas e quantas instalações de contrato tivemos em outubro de 2026?',
    sql: `select vendas, instalacoes from ouro_base_movimentacao_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'vendas', tipo: 'numero', tol: 0.01 }, { coluna: 'instalacoes', tipo: 'numero', tol: 0.01 }],
  },
  // ── Cancelamento ──────────────────────────────────────────────────────
  {
    id: 'canc-taxa-out', tema: 'cancelamento',
    pergunta: 'Qual foi a taxa de cancelamento de outubro de 2026?',
    sql: `select taxa_cancelamento_pct from ouro_cancelamento_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'taxa_cancelamento_pct', tipo: 'pct', tol: 0.06 }],
  },
  {
    id: 'canc-qtd-out', tema: 'cancelamento',
    pergunta: 'Quantos contratos instalados cancelaram em outubro de 2026, sem contar cancelamento em lote e contrato duplicado?',
    sql: `select cancelamentos from ouro_cancelamento_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'cancelamentos', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'canc-motivo-out', tema: 'cancelamento',
    pergunta: 'Em outubro de 2026, qual foi o principal grupo de motivo de cancelamento dos contratos instalados (sem lote e duplicado), e quantos cancelamentos ele teve?',
    sql: `select motivo_grupo, sum(cancelamentos) as cancelamentos from ouro_cancelamento_mensal_por_motivo
           where mes = ${OUT} and motivo_grupo not in ('Venda de operação (lote)', 'Contrato duplicado')
           group by 1 order by 2 desc limit 1`,
    checar: [{ coluna: 'motivo_grupo', tipo: 'texto' }, { coluna: 'cancelamentos', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'canc-receita-out', tema: 'cancelamento',
    pergunta: 'Quanto de receita mensal contratada foi perdida com cancelamentos em outubro de 2026 (sem lote e duplicado)?',
    sql: `select receita_cancelada from ouro_cancelamento_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'receita_cancelada', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'canc-media-12m', tema: 'cancelamento',
    pergunta: 'Qual a média da taxa mensal de cancelamento nos 12 meses de novembro de 2025 a outubro de 2026?',
    sql: `select avg(taxa_cancelamento_pct) as media from ouro_cancelamento_mensal
           where mes between date '2025-11-01' and ${OUT}`,
    checar: [{ coluna: 'media', tipo: 'pct', tol: 0.06 }],
  },
  {
    id: 'canc-nao-instalados-out', tema: 'cancelamento',
    pergunta: 'Quantos contratos vendidos foram cancelados antes de serem instalados, com cancelamento em outubro de 2026?',
    sql: `select canceladas_antes_de_instalar from ouro_cancelamento_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'canceladas_antes_de_instalar', tipo: 'numero', tol: 0.02 }],
  },
  // ── Financeiro ────────────────────────────────────────────────────────
  {
    id: 'fin-faturado-out', tema: 'financeiro',
    pergunta: 'Qual o valor total faturado nas faturas com vencimento em outubro de 2026?',
    sql: `select valor_faturado from ouro_financeiro_faturamento_mensal where mes_vencimento = ${OUT}`,
    checar: [{ coluna: 'valor_faturado', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'fin-recebido-out', tema: 'financeiro',
    pergunta: 'Quanto foi recebido de faturas pagas em outubro de 2026?',
    sql: `select valor_recebido from ouro_financeiro_recebimento_mensal where mes_pagamento = ${OUT}`,
    checar: [{ coluna: 'valor_recebido', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'fin-forma-out', tema: 'financeiro',
    pergunta: 'Em outubro de 2026, qual forma de pagamento foi a mais usada pelas faturas pagas, e qual a participação dela no total de faturas pagas?',
    sql: `select forma_pagamento, participacao_pct from ouro_financeiro_recebimento_por_forma
           where mes_pagamento = ${OUT} order by faturas desc limit 1`,
    checar: [{ coluna: 'forma_pagamento', tipo: 'texto' }, { coluna: 'participacao_pct', tipo: 'pct', tol: 0.6 }],
  },
  {
    id: 'fin-aberto-90d', tema: 'financeiro',
    pergunta: 'Qual o saldo em aberto hoje das faturas vencidas há mais de 90 dias?',
    sql: `select sum(saldo_em_aberto) as saldo from ouro_financeiro_aging_atual
           where faixa_atraso in ('4 · 91 a 180 dias', '5 · 181 a 365 dias', '6 · mais de 1 ano')`,
    checar: [{ coluna: 'saldo', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'fin-inad-jul', tema: 'financeiro',
    pergunta: 'Qual a inadimplência acima de 30 dias das faturas com vencimento em julho de 2026?',
    sql: `select inadimplencia_30d_pct from ouro_financeiro_inadimplencia_por_vencimento where mes_vencimento = date '2026-07-01'`,
    checar: [{ coluna: 'inadimplencia_30d_pct', tipo: 'pct', tol: 0.06 }],
  },
  {
    id: 'fin-ativos-atraso-30d', tema: 'financeiro',
    pergunta: 'Quantos contratos ativos têm fatura em atraso há mais de 30 dias?',
    sql: 'select sum(contratos_em_atraso_30d) as contratos from ouro_financeiro_inadimplencia_por_cidade',
    checar: [{ coluna: 'contratos', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'fin-cobranca-90d', tema: 'financeiro',
    pergunta: 'Quantos contratos estão com a fatura mais atrasada vencida há mais de 90 dias?',
    sql: `select count(*) as contratos from ouro_financeiro_contratos_em_atraso where maior_atraso_dias > 90`,
    checar: [{ coluna: 'contratos', tipo: 'numero', tol: 0.01 }],
  },
  // ── Cruzamentos (exigem juntar conjuntos ou ir à prata) ───────────────
  {
    id: 'cruz-receita-em-atraso', tema: 'cruzamento',
    pergunta: 'Qual a receita mensal contratada dos contratos ativos que têm fatura vencida há mais de 30 dias em aberto?',
    sql: `select round(sum(c.valor_mensal), 2) as receita from prata_voalle_contratos c
           where c.instalado and c.cancelado_em is null
             and c.contrato_id in (select contrato_id from prata_voalle_faturas
                                    where saldo > 0 and not renegociada and dias_em_atraso > 30)`,
    checar: [{ coluna: 'receita', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'cruz-safra-2025', tema: 'cruzamento',
    pergunta: 'Dos contratos instalados em 2025, quantos já cancelaram (sem contar lote e duplicado)?',
    sql: `select count(*) as cancelados from prata_voalle_contratos
           where instalado and year(instalado_em) = 2025 and cancelado_em is not null
             and coalesce(motivo_codigo, '') not in ('FNC.CAN.020', 'OTR.CAN.006')`,
    checar: [{ coluna: 'cancelados', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'cruz-casa-inadimplencia', tema: 'cruzamento',
    pergunta: 'Qual o tempo de casa mediano, em dias, dos contratos que cancelaram por inadimplência em 2026?',
    sql: `select median(dias_de_casa) as dias from prata_voalle_contratos
           where instalado and motivo_grupo = 'Inadimplência' and year(cancelado_em) = 2026`,
    checar: [{ coluna: 'dias', tipo: 'numero', tol: 0.02 }],
  },
  // ── Campo (onda 2) ────────────────────────────────────────────────────
  {
    id: 'campo-ativacoes-out', tema: 'campo',
    pergunta: 'Quantas ativações (instalações de cliente novo) a equipe de campo fez em outubro de 2026?',
    sql: `select ativacoes from ouro_campo_instalacoes_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'ativacoes', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'campo-prazo-out', tema: 'campo',
    pergunta: 'Qual foi o prazo mediano, em dias, entre a abertura do protocolo e a instalação nas ativações de outubro de 2026?',
    sql: `select dias_mediana_ate_instalar from ouro_campo_instalacoes_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'dias_mediana_ate_instalar', tipo: 'numero', tol: 0.05 }],
  },
  {
    id: 'campo-reparos-out', tema: 'campo',
    pergunta: 'Quantos protocolos de reparo (manutenção) foram abertos em outubro de 2026?',
    sql: `select abertos from ouro_campo_reparos_mensal where mes = ${OUT}`,
    checar: [{ coluna: 'abertos', tipo: 'numero', tol: 0.01 }],
  },
  {
    id: 'campo-fila-hoje', tema: 'campo',
    pergunta: 'Quantos protocolos de ativação estão na fila hoje, abertos e ainda sem instalação?',
    sql: 'select sum(protocolos) as protocolos from ouro_campo_ativacao_fila_atual',
    checar: [{ coluna: 'protocolos', tipo: 'numero', tol: 0.01 }],
  },
]

// ── Leitura dos números de uma resposta ──────────────────────────────────
const ESCALAS: [RegExp, number][] = [
  [/^(bilh(ão|ões|oes|ao)|bi)\b/, 1e9],
  [/^(milh(ão|ões|oes|ao)|mi)\b/, 1e6],
  [/^mil\b/, 1e3],
]

/**
 * Todos os números que um texto em pt-BR pode estar dizendo. "2.345" entra
 * como 2345 E como 2,345 (o ponto é milhar em pt-BR, mas o modelo às vezes
 * escreve no padrão americano); qualquer leitura que bata conta.
 */
export function numerosDoTexto(texto: string): number[] {
  const out: number[] = []
  const re = /-?\d[\d.,]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(texto))) {
    const bruto = m[0].replace(/[.,]+$/, '')
    const depois = texto.slice(m.index + m[0].length).trimStart().toLowerCase()
    const escala = ESCALAS.find(([r]) => r.test(depois))?.[1] ?? 1
    const leituras = new Set<number>()
    const temVirgula = bruto.includes(',')
    const temPonto = bruto.includes('.')
    if (temVirgula && temPonto) {
      // 1.234,56 (pt-BR) ou 1,234.56 (en)
      if (bruto.lastIndexOf(',') > bruto.lastIndexOf('.')) leituras.add(Number(bruto.replace(/\./g, '').replace(',', '.')))
      else leituras.add(Number(bruto.replace(/,/g, '')))
    } else if (temVirgula) {
      leituras.add(Number(bruto.replace(',', '.')))
      if (/^-?\d{1,3}(,\d{3})+$/.test(bruto)) leituras.add(Number(bruto.replace(/,/g, '')))
    } else if (temPonto) {
      if (/^-?\d{1,3}(\.\d{3})+$/.test(bruto)) leituras.add(Number(bruto.replace(/\./g, '')))
      leituras.add(Number(bruto))
    } else {
      leituras.add(Number(bruto))
    }
    for (const n of leituras) if (Number.isFinite(n)) out.push(n * escala)
  }
  return out
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export interface ResultadoChecagem { coluna: string; esperado: unknown; ok: boolean }

export function confere(resposta: string, esperado: Record<string, unknown>, checar: Checagem[]): ResultadoChecagem[] {
  const numeros = numerosDoTexto(resposta)
  const texto = semAcento(resposta)
  return checar.map((c) => {
    const v = esperado[c.coluna]
    if (v == null) return { coluna: c.coluna, esperado: v, ok: false }
    if (c.tipo === 'texto') return { coluna: c.coluna, esperado: v, ok: texto.includes(semAcento(String(v))) }
    const alvo = Number(v)
    if (!Number.isFinite(alvo)) return { coluna: c.coluna, esperado: v, ok: false }
    const ok = c.tipo === 'pct'
      ? numeros.some((n) => Math.abs(n - alvo) <= (c.tol ?? 0.06))
      : numeros.some((n) => Math.abs(n - alvo) <= Math.max(Math.abs(alvo) * (c.tol ?? 0.01), 0.5))
    return { coluna: c.coluna, esperado: alvo, ok }
  })
}

// ── Execução ─────────────────────────────────────────────────────────────
export interface ResultadoCaso {
  id: string
  tema: string
  pergunta: string
  status: 'ok' | 'falhou' | 'pulado' | 'erro'
  esperado?: Record<string, unknown>
  checagens?: ResultadoChecagem[]
  resposta?: string
  motivo?: string
  rodadas?: number
  consultas?: number
  consultas_com_erro?: number
  no_limite?: boolean
  ms?: number
}

/** Gabarito: roda o SQL de referência com a mesma porta (e máscara) da IA. */
export async function gabarito(user: SessionUser, sql: string): Promise<Record<string, unknown> | null> {
  const refs = await lakeRefs(user.tenant, { user })
  const { sql: wrapped } = await compileNotebookSql(sql, refs, { admin: false })
  try {
    const r = await duckQuery(`select * from (${wrapped}) as __gab limit 1`, [], { timeoutMs: config.duck.queryTimeoutMs, adhoc: true })
    return r.rows[0] ?? null
  } catch (e) {
    throw friendlyDuckError(e as Error, refs)
  }
}

/** Conjuntos que um SQL de referência cita e que ainda não estão no lake. */
async function faltando(user: SessionUser, sql: string): Promise<string[]> {
  const refs = new Set((await lakeRefs(user.tenant, { user })).map((r) => r.slug))
  const citados = [...new Set([...sql.matchAll(/\b((?:prata|ouro)_[a-z0-9_]+)\b/g)].map((m) => m[1]))]
  return citados.filter((s) => !refs.has(s))
}

export async function avaliaCaso(caso: CasoAvaliacao, user: SessionUser, provider: AIProvider): Promise<ResultadoCaso> {
  const base = { id: caso.id, tema: caso.tema, pergunta: caso.pergunta }
  const falta = await faltando(user, caso.sql)
  if (falta.length) return { ...base, status: 'pulado', motivo: `Conjunto(s) fora do lake: ${falta.join(', ')}` }
  let esperado: Record<string, unknown> | null
  try {
    esperado = await gabarito(user, caso.sql)
  } catch (e) {
    return { ...base, status: 'erro', motivo: `Gabarito falhou: ${(e as Error).message}` }
  }
  if (!esperado || caso.checar.some((c) => esperado![c.coluna] == null)) {
    return { ...base, status: 'pulado', motivo: 'Sem dado para o gabarito (conjunto vazio no período).', esperado: esperado ?? undefined }
  }
  const inicio = Date.now()
  try {
    const r = await responder({ provider, user, messages: [{ role: 'user', content: caso.pergunta }] })
    const checagens = confere(r.text, esperado, caso.checar)
    return {
      ...base,
      status: checagens.every((c) => c.ok) ? 'ok' : 'falhou',
      esperado, checagens,
      resposta: r.text.length > 2000 ? `${r.text.slice(0, 1999)}…` : r.text,
      rodadas: r.rounds,
      consultas: r.trace.length,
      consultas_com_erro: r.trace.filter((t) => t.erro).length,
      no_limite: r.limitReached,
      ms: Date.now() - inicio,
    }
  } catch (e) {
    return { ...base, status: 'erro', esperado, motivo: (e as Error).message, ms: Date.now() - inicio }
  }
}

// Uma avaliação por vez no processo: são dezenas de perguntas ao provedor, e
// duas em paralelo só dobram o custo e a carga do motor.
let rodando: string | null = null
export const avaliacaoEmAndamento = () => rodando

export async function iniciaAvaliacao(user: SessionUser, provider: AIProvider, ids?: string[]): Promise<string> {
  if (rodando) throw new Error('Já há uma avaliação em andamento. Espere terminar.')
  const casos = ids?.length ? CASOS.filter((c) => ids.includes(c.id)) : CASOS
  if (!casos.length) throw new Error('Nenhuma pergunta escolhida.')
  const run = (await db.query(
    `insert into ai_eval_runs (tenant_id, started_by, provider, model, total)
     select t.id, $2, $3, $4, $5 from tenants t where t.slug = $1 returning id`,
    [user.tenant, user.email, provider.name, provider.model, casos.length],
  )).rows[0]
  const id = String(run.id)
  rodando = id
  void (async () => {
    const resultados: ResultadoCaso[] = []
    try {
      for (const caso of casos) {
        resultados.push(await avaliaCaso(caso, user, provider))
        const passed = resultados.filter((r) => r.status === 'ok').length
        const skipped = resultados.filter((r) => r.status === 'pulado').length
        await db.query(`update ai_eval_runs set passed = $2, skipped = $3, results = $4 where id = $1`,
          [id, passed, skipped, JSON.stringify(resultados)])
      }
      await db.query(`update ai_eval_runs set status = 'done', finished_at = now() where id = $1`, [id])
    } catch (e) {
      await db.query(`update ai_eval_runs set status = 'error', error = $2, finished_at = now() where id = $1`,
        [id, (e as Error).message]).catch(() => { /* banco fora: o log basta */ })
      console.warn(`[ai] avaliação ${id} falhou: ${(e as Error).message}`)
    } finally {
      rodando = null
    }
  })()
  return id
}
