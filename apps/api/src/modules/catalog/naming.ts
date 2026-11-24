// ─────────────────────────────────────────────────────────────────────────
// Padrão de nomes dos conjuntos (pedido de 19/11/2026, revisto em 24/11).
//
// FONTE: o nome da TABELA no banco, sem mudança — técnico e de exibição. Uma
// query copiada do banco ("select … from contracts") roda aqui sem ajuste. As
// colunas já eram fiéis: a chave de cada campo é a coluna da fonte. Só quando
// outra fonte já usa o nome é que entra um _2, _3…
//
// CALCULADO: <camada>_<área>_<assunto>[_<período>], minúsculas, "_" entre palavras
//   ex.: prata_cancelamentos_mensal · ouro_financeiro_titulos_abertos_diario
//
// Por que sublinhado e não traço: é o que Databricks, Snowflake, BigQuery e dbt
// usam, porque traço não é identificador SQL — "contratos-ativos" só funciona
// entre aspas. A camada abre o nome (bronze = cópia da fonte, prata = tratado,
// ouro = pronto para a área) e a área diz de onde vem (voalle, autoisp…) ou de
// que assunto é (financeiro, cancelamento…).
//
// Conjunto novo já nasce no padrão. Os antigos passam pela tela "Padronizar
// nomes", que sugere o nome e renomeia um a um; o nome antigo vira APELIDO
// (core/slugAliases.ts) e nada que o usa quebra.
// ─────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../../db/pool.js'
import { LAKE_ROOT } from '../../core/lake.js'
import { getConnector } from '../../connectors/registry.js'
import { loadSlugAliases } from '../../core/slugAliases.js'
import { syncQueueState } from '../sync/ingest.js'
import type { AccessUser } from '../../core/access.js'

export const CAMADAS = ['bronze', 'prata', 'ouro'] as const
export type Camada = typeof CAMADAS[number]

/** Camada + pelo menos uma palavra; só minúsculas, dígitos e "_" entre palavras. */
export const PADRAO_NOME = /^(bronze|prata|ouro)(_[a-z0-9]+)+$/
export const NOME_MAX = 80

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }

/** "Contratos Ativos (2024)" → "contratos_ativos_2024". */
export function snake(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function segueOPadrao(slug: string): boolean {
  return slug.length <= NOME_MAX && PADRAO_NOME.test(slug)
}

export function camadaDoNome(slug: string): Camada | null {
  const m = /^(bronze|prata|ouro)_/.exec(slug)
  return m ? (m[1] as Camada) : null
}

// Nome curto de cada fonte embutida. As cadastradas na tela usam o próprio
// nome; o servidor MariaDB tem vários bancos, e o banco diz mais que o servidor.
const AREA_EMBUTIDA: Record<string, string> = {
  elleven: 'voalle', autoisp: 'autoisp', radius: 'radius', 'datahub-meta': 'datahub',
}

export function areaDaFonte(connectionId: string, schema?: string | null): string {
  if (AREA_EMBUTIDA[connectionId]) return AREA_EMBUTIDA[connectionId]
  if (connectionId === 'maria' && schema) return snake(schema).replace(/^db_/, '').slice(0, 30) || 'mariadb'
  return snake(getConnector(connectionId)?.name ?? connectionId).slice(0, 30).replace(/_+$/, '') || 'fonte'
}

/** Monta o nome no padrão. Nome que já começa por uma camada é respeitado. */
export function nomePadrao(p: { camada: Camada; area?: string | null; nome: string }): string {
  let nome = snake(p.nome) || 'conjunto'
  if (!camadaDoNome(nome)) {
    const area = p.area ? snake(p.area) : ''
    const partes: string[] = [p.camada]
    if (area && nome !== area && !nome.startsWith(`${area}_`)) partes.push(area)
    partes.push(nome)
    nome = partes.join('_')
  }
  return nome.slice(0, NOME_MAX).replace(/_+$/, '')
}

/** Sufixo de desempate no mesmo estilo do nome: _2 no padrão, -2 nos antigos. */
export function comSufixo(base: string, i: number): string {
  return /^[a-z0-9_]+$/.test(base) ? `${base}_${i}` : `${base}-${i}`
}

/**
 * Nomes que um conjunto novo (ou renomeado) não pode usar: os atuais, os
 * apelidos, e a forma com sublinhado de cada um — no SQL, "a-b" também
 * responde por a_b, e dois conjuntos com o mesmo apelido seriam ambíguos.
 */
export async function nomesOcupados(q: Consulta, tenantId: string, exceto?: string): Promise<Set<string>> {
  const atuais = (await q.query(
    'select id, slug from datasets where tenant_id = $1', [tenantId],
  )).rows.filter((r) => String(r.id) !== exceto).map((r) => String(r.slug))
  const apelidos = (await q.query(
    'select old_slug, dataset_id from dataset_slug_aliases where tenant_id = $1', [tenantId],
  )).rows.filter((r) => String(r.dataset_id) !== exceto).map((r) => String(r.old_slug))
  const todos = [...atuais, ...apelidos]
  return new Set([...todos, ...todos.map((s) => s.replace(/-/g, '_'))])
}

export function nomeLivre(base: string, ocupados: Set<string>): string {
  let nome = base
  for (let i = 2; ocupados.has(nome) || ocupados.has(nome.replace(/-/g, '_')); i++) nome = comSufixo(base, i)
  return nome
}

/** Nome livre no padrão para um conjunto novo. */
export async function novoNome(q: Consulta, tenantId: string, p: Parameters<typeof nomePadrao>[0]): Promise<string> {
  return nomeLivre(nomePadrao(p), await nomesOcupados(q, tenantId))
}

// ── Fonte: fiel ao banco ──────────────────────────────────────────────────
/** Nome técnico de uma fonte: o nome da tabela (minúsculo; o SQL daqui não diferencia). */
export function nomeDaFonte(tabela: string): string {
  const t = String(tabela ?? '').trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t.toLowerCase() : (snake(t) || 'fonte')
}

/** O nome técnico é o da tabela (ou ele com _2, _3… quando outra fonte já o usa)? */
export function fonteConforme(slug: string, tabela: string): boolean {
  const base = nomeDaFonte(tabela)
  return slug === base || (slug.startsWith(`${base}_`) && /^\d+$/.test(slug.slice(base.length + 1)))
}

/** Nome livre para uma fonte nova: o da tabela. */
export async function novoNomeFonte(q: Consulta, tenantId: string, tabela: string): Promise<string> {
  return nomeLivre(nomeDaFonte(tabela), await nomesOcupados(q, tenantId))
}

// ── Camada do calculado coerente com o selo do catálogo ───────────────────
// O selo diz: calculado = prata, calculado OFICIAL = ouro (certificado). O nome
// tem de concordar. A primeira rodada de 19/11 sugeria prata_ para todo
// calculado e deixou oficiais com selo Ouro e nome prata_. Calculado não
// oficial pode ser prata ou ouro: os pacotes nascem ouro_ quando o conjunto já
// sai pronto para a área. Fonte não leva camada no nome (é o nome da tabela).
interface CamadaInfo { kind: string; official: boolean | number; slug: string }

export function camadaCoerente(d: CamadaInfo): boolean {
  if (d.kind !== 'derived') return true
  const c = camadaDoNome(d.slug)
  if (d.official) return c === 'ouro'
  return c === 'prata' || c === 'ouro'
}

export function camadaSugerida(d: CamadaInfo): Camada {
  if (d.kind !== 'derived') return 'bronze'
  if (d.official) return 'ouro'
  return camadaDoNome(d.slug) === 'ouro' ? 'ouro' : 'prata'
}

// ── Nome de exibição ──────────────────────────────────────────────────────
// O que aparece em negrito no catálogo. Padrão: frase em português, com
// acentos, só a primeira letra maiúscula; siglas e nomes de sistema na grafia
// deles. Ex.: "Protocolos de instalação - SLAs - técnicos - agendamentos".
// A sugestão é um ponto de partida (não sabe pôr um "de" que faltou): a tela
// deixa editar antes de aplicar.
const GRAFIA: Record<string, string> = Object.fromEntries([
  'SLA', 'SLAs', 'ONU', 'ONUs', 'OLT', 'OLTs', 'CTO', 'CTOs', 'PPPoE', 'PPPoEs', 'FTTH', 'FTTX', 'IP', 'IPs', 'SVA', 'TV',
  'CPF', 'CNPJ', 'CEP', 'UF', 'NF', 'NFe', 'NFs', 'NPS', 'CSAT', 'URA', 'SMS', 'ERP', 'ISP', 'CRM', 'BI', 'KPI', 'KPIs',
  'API', 'APIs', 'IA', 'RH', 'DP', 'TI', 'ID', 'IDs', 'PF', 'PJ', 'LTV', 'MRR', 'ARPU', 'SAC', 'N1', 'N2', 'N3',
  'Voalle', 'Elleven', 'AutoISP', 'Radius', 'Matrix', 'Native', 'Splitters', 'Sebratel', 'Hubsoft', 'Senior',
  'Digisac', 'Jira', 'Zabbix', 'Databricks', 'WhatsApp', 'Google', 'n8n', 'Hub',
].map((w) => [w.toLowerCase(), w]))

// Palavra sem acento que quase sempre o tem. As terminações -ção/-ções/-são/-ão
// têm regra própria (acentua) abaixo.
const ACENTO: Record<string, string> = {
  tecnico: 'técnico', tecnicos: 'técnicos', tecnica: 'técnica', tecnicas: 'técnicas',
  relatorio: 'relatório', relatorios: 'relatórios', titulo: 'título', titulos: 'títulos',
  diario: 'diário', diarios: 'diários', diaria: 'diária', diarias: 'diárias', mes: 'mês',
  area: 'área', areas: 'áreas', periodo: 'período', periodos: 'períodos', historico: 'histórico',
  servico: 'serviço', servicos: 'serviços', cobranca: 'cobrança', cobrancas: 'cobranças',
  analise: 'análise', analises: 'análises', usuario: 'usuário', usuarios: 'usuários',
  credito: 'crédito', debito: 'débito', saude: 'saúde', numero: 'número', numeros: 'números',
  indice: 'índice', indices: 'índices', media: 'média', medias: 'médias', unico: 'único',
  ultimo: 'último', ultima: 'última', ultimos: 'últimos', ultimas: 'últimas', codigo: 'código',
  inadimplencia: 'inadimplência', recorrencia: 'recorrência', frequencia: 'frequência',
  ocorrencia: 'ocorrência', ocorrencias: 'ocorrências', referencia: 'referência', permanencia: 'permanência',
  endereco: 'endereço', enderecos: 'endereços', metrica: 'métrica', metricas: 'métricas',
  estatistica: 'estatística', estatisticas: 'estatísticas', logistica: 'logística', basico: 'básico',
  orcamento: 'orçamento', preco: 'preço', precos: 'preços', inicio: 'início', proximo: 'próximo',
  publico: 'público', eletronica: 'eletrônica', eletronico: 'eletrônico', automatico: 'automático',
  negocio: 'negócio', negocios: 'negócios', funcionario: 'funcionário', funcionarios: 'funcionários',
  salario: 'salário', horario: 'horário', horarios: 'horários', calendario: 'calendário',
  veiculo: 'veículo', veiculos: 'veículos', pagina: 'página', cenario: 'cenário', ja: 'já', ate: 'até',
}

/** Palavra em minúsculas ASCII → com acento, se for o caso. */
function acentua(w: string): string {
  if (ACENTO[w]) return ACENTO[w]
  if (w.length < 4) return w
  const m = /^(.*[a-z])(cao|coes|sao|soes|xao|xoes)$/.exec(w)
  if (m) {
    const fim: Record<string, string> = { cao: 'ção', coes: 'ções', sao: 'são', soes: 'sões', xao: 'xão', xoes: 'xões' }
    return m[1] + fim[m[2]]
  }
  return w
}

const LETRAS = /[A-Za-zÀ-ÖØ-öø-ÿ]/
const ehMaiuscula = (w: string) => w === w.toLocaleUpperCase('pt-BR') && w !== w.toLocaleLowerCase('pt-BR')
const ehCapitalizada = (w: string) => /^[A-ZÀ-Ö]/.test(w) && w.slice(1) === w.slice(1).toLocaleLowerCase('pt-BR')

/** Palavras do nome (só letras e dígitos), sem as de grafia própria (siglas, sistemas). */
function palavrasComuns(s: string): string[] {
  return s.split(/\s+/).map((p) => p.replace(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ]/g, ''))
    .filter((p) => LETRAS.test(p) && !GRAFIA[p.toLocaleLowerCase('pt-BR')])
}

/** Nome em CAIXA ALTA: toda palavra comum de 2+ letras está em maiúsculas. */
function emCaixaAlta(s: string): boolean {
  const longas = palavrasComuns(s).filter((p) => p.length > 1)
  return longas.length > 0 && longas.every(ehMaiuscula)
}

/** Nome de exibição no padrão, a partir do atual (ou do nome da tabela). */
export function nomeExibicao(atual: string): string {
  let s = String(atual ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return s
  // Sem espaço nenhum ("cesta-produtos", "assignment_links"): o separador é o "_"/"-".
  if (!/\s/.test(s)) s = s.replace(/[_\-.]+/g, ' ').trim()
  else s = s.replace(/_+/g, ' ')
  const caixaAlta = emCaixaAlta(s)
  const palavras = s.split(' ')
  const saida = palavras.map((p) => {
    // Pontuação em volta da palavra ("(2024)", "SLAs,") fica como está.
    const m = /^([^0-9A-Za-zÀ-ÖØ-öø-ÿ]*)(.*?)([^0-9A-Za-zÀ-ÖØ-öø-ÿ]*)$/.exec(p)!
    const [, antes, w, depois] = m
    if (!w || !LETRAS.test(w)) return p
    const baixa = w.toLocaleLowerCase('pt-BR')
    if (GRAFIA[baixa]) return antes + GRAFIA[baixa] + depois
    // Fora de um nome todo em caixa alta, maiúscula que não é só a inicial foi
    // de propósito: sigla (R$, CTO) ou grafia própria (AutoISP). Respeita.
    if (!caixaAlta && w !== baixa && (!ehCapitalizada(w) || w.length === 1)) return p
    // Ascii puro em minúsculas: tenta pôr o acento que faltou.
    const final = /^[a-z0-9]+$/.test(baixa) ? acentua(baixa) : baixa
    return antes + final + depois
  })
  // Primeira letra maiúscula (sem estragar sigla/nome com grafia própria).
  const i = saida.findIndex((p) => LETRAS.test(p))
  if (i >= 0 && !GRAFIA[saida[i].replace(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ]/g, '').toLocaleLowerCase('pt-BR')]) {
    const p = saida[i]
    const j = p.search(LETRAS)
    saida[i] = p.slice(0, j) + p[j].toLocaleUpperCase('pt-BR') + p.slice(j + 1)
  }
  return saida.join(' ')
}

/**
 * O nome de exibição está fora do padrão? Só acusa o que é claramente fora —
 * cara de nome técnico, caixa alta, Título Em Maiúsculas, primeira letra
 * minúscula ou -cao/-coes sem acento —, para um nome bom com um nome próprio
 * no meio ("Clientes da Cidade Nova") não ficar acusado para sempre.
 */
export function exibicaoForaDoPadrao(atual: string): boolean {
  const s = String(atual ?? '').trim()
  if (!s || nomeExibicao(s) === s) return false
  const palavras = s.split(/\s+/).map((p) => p.replace(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ]/g, '')).filter((p) => LETRAS.test(p))
  const comuns = palavrasComuns(s)
  const pareceTecnico = /[_]/.test(s) || (!/\s/.test(s) && /-/.test(s))
  const caixaAlta = emCaixaAlta(s)
  const longas = comuns.filter((p) => p.length >= 4)
  const titulo = longas.length >= 3 && longas.every((p) => ehCapitalizada(p))
  const primeiraMinuscula = /^[^A-Za-zÀ-ÖØ-öø-ÿ]*[a-zà-ÿ]/.test(s) && !GRAFIA[(palavras[0] ?? '').toLowerCase()]
  const semAcento = palavras.some((p) => /^[a-z]{2,}(cao|coes)$/i.test(p))
  return pareceTecnico || caixaAlta || titulo || primeiraMinuscula || semAcento
}

// ── Sugestão para os conjuntos que já existem ─────────────────────────────
interface LinhaNome {
  id: string; slug: string; name: string; kind: string; official: boolean
  connection_id: string; schema_name: string; object_name: string; databricks_layer: string | null
  http: boolean | number
}

/**
 * Qual regra vale: 'fonte' (tabela de banco: nome da tabela), 'api' (fonte HTTP:
 * não tem tabela, segue o padrão com camada) ou 'calculado'.
 */
export type RegraNome = 'fonte' | 'api' | 'calculado'
export function regraDoNome(d: { kind: string; http?: boolean | number | null }): RegraNome {
  if (d.kind === 'derived') return 'calculado'
  return d.http ? 'api' : 'fonte'
}

function sugestaoBase(d: LinhaNome): string {
  if (regraDoNome(d) === 'fonte') return nomeDaFonte(d.object_name)
  const derivado = d.kind === 'derived'
  const camada = camadaSugerida(d)
  // Já no padrão, só com a camada errada: troca a camada e mantém o resto.
  const atual = camadaDoNome(d.slug)
  if (atual && segueOPadrao(d.slug)) return `${camada}${d.slug.slice(atual.length)}`
  return nomePadrao({
    camada,
    area: derivado ? null : areaDaFonte(d.connection_id, d.schema_name),
    nome: d.slug,
  })
}

export interface ItemNome {
  id: string; slug: string; name: string; kind: 'source' | 'derived'; official: boolean
  regra: RegraNome
  /** Nome técnico no padrão (fonte: o da tabela; calculado: camada certa). */
  conforme: boolean; sugestao: string | null; apelidos: string[]
  /** Nome de exibição no padrão (fonte: o da tabela; calculado: frase, acentos, siglas). */
  nomeConforme: boolean; sugestaoNome: string | null
}

export async function listaNomes(tenantSlug: string): Promise<ItemNome[]> {
  const tenant = (await db.query('select id from tenants where slug = $1', [tenantSlug])).rows[0]
  if (!tenant) return []
  const rows = (await db.query(
    `select id, slug, name, kind, official, connection_id, schema_name, object_name, databricks_layer,
            case when source_config is null then 0 else 1 end as http
       from datasets where tenant_id = $1 order by name`, [tenant.id],
  )).rows as unknown as LinhaNome[]
  const apelidos = (await db.query(
    'select old_slug, dataset_id from dataset_slug_aliases where tenant_id = $1 order by created_at', [tenant.id],
  )).rows
  const ocupados = await nomesOcupados(db, String(tenant.id))
  return rows.map((d) => {
    const regra = regraDoNome(d)
    const conforme = regra === 'fonte'
      ? fonteConforme(String(d.slug), String(d.object_name))
      : segueOPadrao(d.slug) && camadaCoerente(d)
    // Fonte: o nome de exibição é o da tabela, exatamente. Fonte HTTP não tem
    // tabela — o nome dela é livre. Calculado: frase no padrão.
    const nomeConforme = regra === 'fonte' ? String(d.name) === String(d.object_name)
      : regra === 'api' ? true
        : !exibicaoForaDoPadrao(d.name)
    let sugestao: string | null = null
    if (!conforme) {
      // A sugestão de um conjunto não pode colidir com a de outro da lista.
      const livres = new Set(ocupados)
      for (const n of [d.slug, ...apelidos.filter((a) => String(a.dataset_id) === String(d.id)).map((a) => String(a.old_slug))]) {
        livres.delete(n); livres.delete(n.replace(/-/g, '_'))
      }
      sugestao = nomeLivre(sugestaoBase(d), livres)
      ocupados.add(sugestao)
    }
    return {
      id: String(d.id), slug: String(d.slug), name: String(d.name),
      kind: d.kind === 'derived' ? 'derived' : 'source', official: !!d.official, regra,
      conforme, sugestao,
      apelidos: apelidos.filter((a) => String(a.dataset_id) === String(d.id)).map((a) => String(a.old_slug)),
      nomeConforme,
      sugestaoNome: nomeConforme ? null : regra === 'fonte' ? String(d.object_name) : nomeExibicao(String(d.name)),
    }
  })
}

// ── Renomear ──────────────────────────────────────────────────────────────
export class NamingError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface RenameUser extends AccessUser { master?: boolean }

/**
 * Troca o nome de um conjunto. Numa transação: o nome, o apelido do nome
 * antigo e as referências GRAVADAS por nome (escopo de token, API do
 * construtor, modelo, filtro de aba de painel). SQL salvo não é reescrito —
 * o apelido o mantém funcionando. A pasta do lake muda junto; se a troca da
 * pasta falhar, nada muda.
 */
export async function renameDataset(user: RenameUser, datasetId: string, pedido: string): Promise<{ from: string; to: string }> {
  const novo = String(pedido ?? '').trim().toLowerCase()
  const ds = (await db.query(
    `select d.id, d.slug, d.kind, d.official, d.tenant_id, d.object_name,
            case when d.source_config is null then 0 else 1 end as http
       from datasets d
       join tenants t on t.id = d.tenant_id where t.slug = $1 and d.id = $2`,
    [user.tenant, datasetId],
  )).rows[0]
  if (!ds) throw new NamingError(404, 'Conjunto de dados não encontrado.')
  // Mesmo critério da lixeira (D-DSP-3): o oficial é contrato com quem o usa.
  if (ds.official && !user.master) throw new NamingError(403, 'Conjunto oficial: só um admin master renomeia.')
  const antigo = String(ds.slug)
  if (novo === antigo) throw new NamingError(400, 'O conjunto já tem esse nome.')
  const regra = regraDoNome({ kind: String(ds.kind), http: ds.http as number })
  if (regra === 'fonte') {
    if (!fonteConforme(novo, String(ds.object_name))) {
      const base = nomeDaFonte(String(ds.object_name))
      throw new NamingError(400,
        `Fonte usa o nome da tabela no banco: "${base}" (ou ${base}_2, ${base}_3… se outra fonte já o usa). ` +
        'Assim uma query copiada do banco roda aqui sem ajuste.')
    }
  } else if (!segueOPadrao(novo)) {
    throw new NamingError(400,
      `Nome fora do padrão: use <camada>_<área>_<assunto>, em minúsculas e com "_" entre as palavras ` +
      `(camada: bronze, prata ou ouro; até ${NOME_MAX} caracteres). Ex.: prata_cancelamentos_mensal.`)
  }
  const tenantId = String(ds.tenant_id)
  const ocupados = await nomesOcupados(db, tenantId, String(ds.id))
  if (ocupados.has(novo)) throw new NamingError(409, `O nome "${novo}" já é de outro conjunto (ou foi, e ficou como apelido).`)
  if (syncQueueState(String(ds.id)).state !== 'idle') {
    throw new NamingError(409, 'O conjunto está atualizando ou na fila. Espere a carga terminar e renomeie de novo.')
  }

  const origem = join(LAKE_ROOT, user.tenant, antigo)
  const destino = join(LAKE_ROOT, user.tenant, novo)
  if (existsSync(destino) && readdirSync(destino).length) {
    throw new NamingError(409, `Já existe uma pasta "${novo}" no lake com arquivos. Avise o suporte antes de usar esse nome.`)
  }

  const client = await db.connect()
  let moveu = false
  try {
    await client.query('begin')
    await client.query(
      `update datasets set slug = $2,
              object_name = case when kind = 'derived' then $2 else object_name end,
              databricks_layer = $3, updated_at = now()
        where id = $1`,
      // Fonte não traz a camada no nome: no Databricks ela vai para bronze.
      [ds.id, novo, regra === 'calculado' ? camadaDoNome(novo) : 'bronze'],
    )
    // Voltar a um nome antigo DESTE conjunto: o apelido dá lugar ao nome.
    await client.query('delete from dataset_slug_aliases where tenant_id = $1 and old_slug = $2', [tenantId, novo])
    await client.query(
      'insert into dataset_slug_aliases (tenant_id, old_slug, dataset_id) values ($1, $2, $3)',
      [tenantId, antigo, ds.id],
    )
    // Escopo de token: a lista de conjuntos é por nome.
    for (const c of (await client.query(
      'select id, dataset_slugs from api_credentials where tenant_id = $1', [tenantId],
    )).rows) {
      const lista = (Array.isArray(c.dataset_slugs) ? c.dataset_slugs : []) as string[]
      if (lista.includes(antigo)) {
        await client.query('update api_credentials set dataset_slugs = $2 where id = $1',
          [c.id, lista.map((s) => (s === antigo ? novo : s))])
      }
    }
    await client.query('update api_products set dataset_slug = $3 where tenant_id = $1 and dataset_slug = $2', [tenantId, antigo, novo])
    await client.query('update ml_models set dataset_slug = $3 where tenant_id = $1 and dataset_slug = $2', [tenantId, antigo, novo])
    // Filtro de aba: vale para os gráficos do MESMO conjunto, comparados por nome.
    for (const t of (await client.query(
      `select dt.id, dt.config from dashboard_tabs dt join dashboards d on d.id = dt.dashboard_id
        where d.tenant_id = $1 and dt.config is not null`, [tenantId],
    )).rows) {
      const cfg = (typeof t.config === 'string' ? JSON.parse(t.config) : t.config) as { filters?: Array<{ datasetSlug?: string }> } | null
      if (!cfg?.filters?.some((f) => f.datasetSlug === antigo)) continue
      cfg.filters = cfg.filters.map((f) => (f.datasetSlug === antigo ? { ...f, datasetSlug: novo } : f))
      await client.query('update dashboard_tabs set config = $2::jsonb where id = $1', [t.id, JSON.stringify(cfg)])
    }
    // A pasta muda por último e DENTRO da transação: se falhar, nada muda.
    if (existsSync(origem)) {
      if (existsSync(destino)) rmdirSync(destino) // vazia (conferido acima): uma leitura do nome a criou
      renameSync(origem, destino)
      moveu = true
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => { /* conexão já perdida */ })
    if (moveu) {
      try { renameSync(destino, origem) } catch (e2) {
        console.error(`[nomes] pasta de "${antigo}" ficou em "${novo}" após falha: ${(e2 as Error).message}`)
      }
    }
    throw e
  } finally {
    client.release()
  }
  await loadSlugAliases()
  return { from: antigo, to: novo }
}
