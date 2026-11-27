// ─────────────────────────────────────────────────────────────────────────
// Tools da IA (docs §12). Tudo roda com o acesso do usuário logado — a IA só
// vê o que ele pode ver, e nunca um campo sensível em claro, nem quando quem
// pergunta é admin (SEG-05).
//
// Duas formas de consultar:
//   • run_query — QueryDef estruturado, um conjunto por vez (o mesmo do
//     explorador e dos painéis). Bom para contagem e agrupamento simples.
//   • run_sql (27/11/2026) — SELECT livre sobre o lake, com JOIN entre
//     conjuntos, CTE e janela. Passa pela MESMA porta do Notebook
//     (compileNotebookSql): validação pela árvore do DuckDB, só os conjuntos
//     que a pessoa lê, coluna oculta fora e sensível mascarado — sempre como
//     não-admin, porque o resultado sai da empresa. Pergunta de negócio cruza
//     contrato, fatura e cliente; sem JOIN o assistente não chegava lá.
// ─────────────────────────────────────────────────────────────────────────
import type { QueryDef, SessionUser, FieldType } from '@datahub/shared'
import { db, dbDriver } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { accessibleDatasetIds, canQuery } from '../../core/access.js'
import { recordUsage } from '../../core/usage.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { currentSlugFor } from '../../core/slugAliases.js'
import {
  lakeRefs, compileNotebookSql, validateTransformSql, assertReferencesAllowed, friendlyDuckError,
} from '../transform/derive.js'
import { embedQuery, toVectorLiteral, embeddingsEnabled } from './embeddings.js'
import { conhecimentoDaTabela, conhecimentoDoPacote } from './knowledge.js'
import { perfilDoConjunto, chavePerfil } from './profile.js'
import type { AiToolDef } from './provider.js'

export const AI_TOOLS: AiToolDef[] = [
  {
    name: 'search_datasets',
    description: 'Busca conjuntos de dados por SIGNIFICADO (busca semântica). Passe em "query" a intenção do usuário em linguagem natural (ex.: "clientes que cancelaram", "faturamento por plano") — não precisa acertar o nome exato do conjunto. Retorna os mais relevantes (nome, slug, descrição, nº de registros). Sem query, lista todos. Chame primeiro para descobrir onde estão os dados da pergunta.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Intenção/tema em linguagem natural. Ex.: "clientes ativos por cidade".' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_dataset_schema',
    description: 'Abre um conjunto para você ENTENDÊ-LO antes de consultar: o que uma linha representa, as armadilhas conhecidas, o nome para usar no SQL, a tabela de origem, os campos (tipo, descrição, % de nulos, mínimo e máximo, e os valores reais com a contagem de cada um), o SQL que calcula o conjunto (se for calculado), as notas da equipe e as métricas da biblioteca. Chame antes de consultar um conjunto pela primeira vez.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Slug do conjunto de dados' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_field_values',
    description: 'Lista os VALORES que um campo realmente tem, com quantas linhas têm cada um (os mais frequentes primeiro). Use SEMPRE antes de filtrar por categoria, status, tag, motivo, plano, cidade ou qualquer texto: o valor gravado raramente é igual ao que a pessoa escreveu (ex.: "desbloqueio de confiança" está gravado como "ISA_DESBLOQUEIO_CONFIANÇA"). Em "search", passe as palavras do que procura: a busca ignora acento, maiúscula, espaço e "_" e exige todas as palavras. Campos que guardam várias tags numa célula ("A || B") são separados sozinhos, e a contagem vira o número de linhas que têm cada tag — que já é a frequência daquela tag.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Slug do conjunto' },
        field: { type: 'string', description: 'Key do campo (de get_dataset_schema)' },
        search: { type: 'string', description: 'Opcional. Palavras do valor procurado. Ex.: "segunda via boleto", "desbloq".' },
        separator: { type: 'string', description: 'Opcional. Separador quando a célula guarda uma lista (ex.: ",", ";"). "||" é detectado sozinho.' },
      },
      required: ['dataset', 'field'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_sql',
    description: 'Executa UMA consulta SELECT (ou WITH) em SQL do DuckDB sobre o lake e devolve as linhas. Pode juntar conjuntos (JOIN), usar CTE, subconsulta, janela (lag, row_number), date_trunc, filter (where …). Cite cada conjunto pelo nome_no_sql (o slug com "_" no lugar de "-"), ex.: select count(*) from prata_voalle_contratos where instalado and cancelado_em is null. Também aceita a maior parte do SQL do Postgres (to_char, ::text, ilike, erp.contracts para a fonte que copia essa tabela). AGREGUE no SQL: o resultado volta limitado a algumas centenas de linhas. Campo sensível vem mascarado. Se der erro, leia a mensagem, corrija e tente de novo.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Uma única consulta SELECT/WITH.' },
        objetivo: { type: 'string', description: 'Em poucas palavras, o que esta consulta verifica (aparece para a pessoa enquanto você trabalha).' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_query',
    description: 'Executa uma consulta estruturada (QueryDef) sobre um conjunto sincronizado no lake e retorna as linhas. Use os KEYS dos campos (não os rótulos). Para agregar: select com {field, agg, as} + groupBy. Operadores de filtro: =, !=, >, >=, <, <=, contains, starts_with, in, is_null, not_null, between. Para filtrar por um valor de texto, use o valor EXATO que list_field_values devolveu.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Slug do conjunto' },
        select: { type: 'array', items: {}, description: 'Campos (string) e/ou agregações {field, agg, as} ou métricas {metric, as}' },
        filters: { type: 'array', items: {}, description: 'Lista de {field, op, value}' },
        groupBy: { type: 'array', items: { type: 'string' } },
        orderBy: { type: 'array', items: {}, description: 'Lista de {field, dir}' },
        limit: { type: 'number' },
      },
      required: ['dataset'],
      additionalProperties: false,
    },
  },
  {
    name: 'render_chart',
    description: 'Mostra um gráfico para o usuário a partir de um conjunto sincronizado. Use depois de validar com run_query que os dados existem. type kpi não usa dimension.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['kpi', 'line', 'bar', 'pie', 'area', 'table'] },
        title: { type: 'string' },
        dataset: { type: 'string', description: 'Slug do conjunto' },
        dimension: { type: 'string', description: 'Campo do eixo/categoria (omitir para kpi)' },
        metric: { type: 'object', description: '{metric: slug} da biblioteca OU {field, agg}' },
        filters: { type: 'array', items: {} },
      },
      required: ['type', 'dataset', 'metric'],
      additionalProperties: false,
    },
  },
]

// Tool exclusiva do CONSTRUTOR de widgets do dashboard (não entra no chat): a
// IA devolve uma LISTA de widgets prontos para o usuário adicionar a uma aba.
// Cada widget é validado (a consulta é executada) antes de ser proposto.
export const PROPOSE_WIDGETS_TOOL: AiToolDef = {
  name: 'propose_widgets',
  description: 'Propõe um ou mais widgets prontos para o dashboard. Chame UMA vez, no fim. Cada widget vira um cartão que o usuário adiciona à aba. Só use conjuntos e campos reais (via get_dataset_schema). Se algum widget for inválido, a tool devolve o erro e você corrige e chama de novo.',
  inputSchema: {
    type: 'object',
    properties: {
      widgets: {
        type: 'array',
        description: 'Lista de widgets (1 a 6). Cada item: {type, dataset(slug), title, dimension?, metric, filters?, style?}',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['kpi', 'line', 'bar', 'pie', 'area', 'table'] },
            dataset: { type: 'string', description: 'Slug do conjunto' },
            title: { type: 'string', description: 'Título curto em português' },
            dimension: { type: 'string', description: 'Campo do eixo/categoria (omitir para kpi)' },
            metric: { type: 'object', description: '{metric: slug} da biblioteca OU {field, agg}' },
            filters: { type: 'array', items: {} },
            style: { type: 'object', description: 'Opcional: {color, numberFormat, showDataLabels, showLegend, target, subtitle}' },
          },
          required: ['type', 'dataset', 'metric'],
          additionalProperties: false,
        },
      },
    },
    required: ['widgets'],
    additionalProperties: false,
  },
}

// Ferramentas do construtor de widgets: reusa a descoberta/validação do chat
// (busca semântica, schema, run_query) e troca render_chart por propose_widgets.
// run_sql fica de fora: o widget é um QueryDef, e o SQL explorado ali não
// viraria widget nenhum.
export const WIDGET_BUILDER_TOOLS: AiToolDef[] = [
  ...AI_TOOLS.filter((t) => t.name !== 'render_chart' && t.name !== 'run_sql'),
  PROPOSE_WIDGETS_TOOL,
]

// Só no chat: a análise vira um Notebook da pessoa (SQL + texto), que ela abre,
// roda de novo, ajusta e compartilha. É o "relatório" que sobrevive à conversa.
export const CREATE_NOTEBOOK_TOOL: AiToolDef = {
  name: 'create_notebook',
  description: 'Salva a análise como um Notebook da pessoa (privado, no nome dela): células de texto (markdown) explicando e células SQL com as consultas que você usou. Use quando pedirem relatório, análise para guardar/compartilhar, ou "monta um notebook". Cada célula SQL é conferida antes de salvar; se alguma falhar, corrija e chame de novo. Depois, dê o link na resposta.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nome curto do notebook (ex.: "Cancelamento por motivo — 2026").' },
      description: { type: 'string', description: 'Uma frase sobre o que a análise responde.' },
      cells: {
        type: 'array',
        description: 'Células na ordem: {kind: "markdown" | "sql", source}. Comece com um texto de contexto; cada SQL vem precedido de um texto curto dizendo o que mostra; termine com as conclusões.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['markdown', 'sql'] },
            source: { type: 'string' },
          },
          required: ['kind', 'source'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'cells'],
    additionalProperties: false,
  },
}

export const CHAT_TOOLS: AiToolDef[] = [...AI_TOOLS, CREATE_NOTEBOOK_TOOL]

export interface ToolOutcome {
  content: string
  isError?: boolean
  chart?: Record<string, unknown> // presença = render_chart bem-sucedido
  widgets?: Record<string, unknown>[] // presença = propose_widgets bem-sucedido
  notebook?: { slug: string; name: string } // presença = create_notebook bem-sucedido
}

// Conjuntos referenciados no input de uma tool (para checar o escopo).
function slugsInInput(name: string, input: Record<string, unknown>): string[] {
  if (name === 'get_dataset_schema') return [String(input.slug ?? '')]
  if (name === 'run_query' || name === 'list_field_values') return [String(input.dataset ?? '')]
  if (name === 'propose_widgets') {
    const ws = Array.isArray(input.widgets) ? (input.widgets as Record<string, unknown>[]) : []
    return ws.map((w) => String(w.dataset ?? w.datasetSlug ?? ''))
  }
  return []
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  user: SessionUser,
  allowed?: Set<string>, // se definido, a IA só pode tocar nestes conjuntos (slug)
): Promise<ToolOutcome> {
  try {
    // SQL livre não cabe num escopo fechado de conjuntos (o construtor de
    // widgets): conferir conjunto a conjunto o que um SELECT cita é trabalho
    // da porta do notebook, que lá não se aplica.
    if (allowed && (name === 'run_sql' || name === 'create_notebook')) {
      return { content: `A ferramenta ${name} não está disponível aqui. Use run_query.`, isError: true }
    }
    // Escopo: barra qualquer conjunto fora da seleção (exceto a busca, que já é filtrada).
    if (allowed && name !== 'search_datasets') {
      const refs = slugsInInput(name, input).filter(Boolean)
      const fora = refs.filter((s) => !allowed.has(s))
      if (fora.length) {
        return { content: `Fora do escopo: ${fora.join(', ')}. Use SOMENTE: ${[...allowed].join(', ')}.`, isError: true }
      }
    }
    switch (name) {
      case 'search_datasets': return await searchDatasets(user, input.query ? String(input.query) : undefined, allowed)
      case 'get_dataset_schema': return await getSchema(String(input.slug ?? ''), user)
      case 'list_field_values': return await listFieldValues(input, user)
      case 'run_query': return await runQuery(input as unknown as QueryDef, user)
      case 'run_sql': return await runSql(input, user)
      case 'create_notebook': return await createNotebook(input, user)
      case 'render_chart': return await renderChart(input, user)
      case 'propose_widgets': return await proposeWidgets(input, user)
      default: return { content: `Tool desconhecida: ${name}`, isError: true }
    }
  } catch (e) {
    return { content: `Erro: ${(e as Error).message}`, isError: true }
  }
}

// MariaDB (sem pgvector antes da 11.7): a distância de cosseno é calculada aqui,
// a mesma que o operador <=> daria. O vetor fica gravado como o texto '[…]'.
// São algumas centenas de conjuntos por tenant — ler os vetores e ordenar em
// memória custa milissegundos.
async function nearestInProcess(tenant: string, q: number[]): Promise<Record<string, unknown>[]> {
  const cand = (await db.query(
    `select d.id, d.slug, d.name, d.kind, d.official, d.description, d.row_count, d.last_sync_at, d.embedding
       from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.embedding is not null`,
    [tenant],
  )).rows
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  const nq = norm(q)
  return cand
    .map(({ embedding, ...r }) => {
      let v: number[]
      try { v = JSON.parse(String(embedding)) as number[] } catch { return null }
      if (!Array.isArray(v) || v.length !== q.length) return null
      let dot = 0
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i]
      return { ...r, distance: 1 - dot / (norm(v) * nq) }
    })
    .filter((r): r is Record<string, unknown> & { distance: number } => r !== null)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 50)
}

// Busca semântica (RAG): se vier `query`, vetorizamos a intenção e ordenamos
// os datasets pela DISTÂNCIA DE COSSENO (operador <=> do pgvector) — menor
// distância = mais parecido. Filtramos pelo acesso do usuário e devolvemos o
// topo. Sem query (ou sem embeddings ainda), caímos no comportamento antigo
// (lista alfabética) — degradação graciosa, o chat nunca quebra.
async function searchDatasets(user: SessionUser, query?: string, scope?: Set<string>): Promise<ToolOutcome> {
  const allowed = await accessibleDatasetIds(user)

  let rows: Record<string, unknown>[] = []
  if (query && query.trim() && embeddingsEnabled()) {
    try {
      const q = await embedQuery(query.trim())
      if (dbDriver === 'mariadb') {
        rows = await nearestInProcess(user.tenant, q)
      } else {
      const vec = toVectorLiteral(q)
      rows = (await db.query(
        `select d.id, d.slug, d.name, d.kind, d.official, d.description, d.row_count, d.last_sync_at,
                (d.embedding <=> $2::vector) as distance
           from datasets d join tenants t on t.id = d.tenant_id
          where t.slug = $1 and d.embedding is not null
          order by d.embedding <=> $2::vector
          limit 50`,
        [user.tenant, vec],
      )).rows
      }
    } catch (e) {
      // Vetorização indisponível → não quebra o chat; cai no fallback textual.
      console.warn(`[ai] busca semântica falhou, usando fallback textual: ${(e as Error).message}`)
      rows = []
    }
  }

  // Fallback: sem query, ou nenhum dataset indexado ainda → lista alfabética.
  if (!rows.length) {
    rows = (await db.query(
      `select d.id, d.slug, d.name, d.kind, d.official, d.description, d.row_count, d.last_sync_at
         from datasets d join tenants t on t.id = d.tenant_id
        where t.slug = $1 order by d.official desc, d.name`,
      [user.tenant],
    )).rows
  }

  const list = rows
    .filter((r) => allowed.has(String(r.id))) // só o que o usuário acessa (após ordenar)
    .filter((r) => !scope || scope.has(String(r.slug))) // escopo selecionado no painel
    .slice(0, query ? 10 : 200)               // busca → só os mais relevantes
    .map((r) => ({
      slug: r.slug, nome_no_sql: String(r.slug).replace(/-/g, '_'), name: r.name,
      tipo: r.kind === 'derived' ? 'calculado' : 'fonte', ...(r.official ? { oficial: true } : {}),
      description: r.description, rows: r.row_count, sincronizado: !!r.last_sync_at,
    }))
  return { content: JSON.stringify(list) }
}

async function loadDataset(pedido: string, user: SessionUser) {
  // Nome antigo de um renomeado (a conversa pode ser de antes) vale como o atual.
  const slug = currentSlugFor(pedido) ?? pedido
  const ds = (await db.query(
    `select d.* , t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [user.tenant, slug],
  )).rows[0]
  if (!ds) throw new Error(`Conjunto não encontrado: ${slug}`)
  // A IA age como o usuário: sem acesso, o conjunto "não existe" para ela.
  if (!(await canQuery(user, String(ds.id)))) {
    throw new Error(`Conjunto não encontrado: ${slug}`)
  }
  return ds
}

// Teto do SQL de um calculado no que vai ao modelo: o SQL é a melhor
// documentação do conjunto, mas os maiores passam de 10 mil caracteres.
const MAX_SQL_DO_CALCULO = 6_000

/** Notas que a equipe escreveu para o conjunto (ai_dataset_notes). */
export async function notasDaEquipe(datasetId: string): Promise<string | null> {
  const r = (await db.query(`select notes from ai_dataset_notes where dataset_id = $1`, [datasetId])).rows[0]
  const t = String(r?.notes ?? '').trim()
  return t || null
}

/**
 * Tudo o que o assistente sabe de UM conjunto, juntando as quatro camadas
 * (knowledge.ts) e o perfil automático. É o que get_dataset_schema devolve e
 * o que a tela "O que a IA sabe" mostra.
 */
export async function conhecimentoDoConjunto(ds: Record<string, unknown>, opts: { perfil: boolean }) {
  const slug = String(ds.slug)
  const fonte = ds.kind !== 'derived'
  const daTabela = fonte ? conhecimentoDaTabela(ds.schema_name as string | null, ds.object_name as string | null) : null
  const doPacote = conhecimentoDoPacote(slug)
  const notas = await notasDaEquipe(String(ds.id))

  const fields = (await db.query(
    `select key, label, description, type, sensitive from dataset_fields
      where dataset_id = $1 and not hidden order by sort_order`,
    [ds.id],
  )).rows as { key: string; label: string; description: string | null; type: string; sensitive: boolean }[]

  const notaDoCampo = (k: string) => doPacote?.campos?.[k] ?? daTabela?.campos?.[k] ?? null
  let perfil: Awaited<ReturnType<typeof perfilDoConjunto>> | null = null
  if (opts.perfil) {
    const dir = datasetDir(String(ds.tenant_slug), slug)
    if (listParquet(dir).length) {
      perfil = await perfilDoConjunto(
        chavePerfil(String(ds.id), ds.last_sync_at, ds.row_count), parquetGlob(dir),
        fields.map((f) => ({ key: f.key, type: f.type, sensitive: !!f.sensitive })),
      )
    }
  }
  const perfilDe = new Map((perfil?.campos ?? []).map((p) => [p.key, p]))

  const campos = fields.map((f) => {
    const p = perfilDe.get(f.key)
    const { key: _k, tipo: _t, sensivel: _s, ...stats } = p ?? { key: '', tipo: '' }
    return {
      key: f.key,
      ...(f.label && f.label !== f.key ? { label: f.label } : {}),
      type: f.type,
      ...(f.description ? { description: f.description } : {}),
      ...(notaDoCampo(f.key) ? { nota: notaDoCampo(f.key) } : {}),
      ...(f.sensitive ? { sensivel: 'valor mascarado; não filtre, agrupe nem ordene por ele' } : {}),
      ...stats,
    }
  })

  const conhecimento = {
    ...(doPacote ? { pacote: doPacote.pacote } : {}),
    resumo: doPacote?.resumo ?? daTabela?.resumo ?? null,
    grao: doPacote?.grao ?? daTabela?.grao ?? null,
    armadilhas: [...(daTabela?.armadilhas ?? []), ...(doPacote?.armadilhas ?? [])],
    ...(notas ? { notas_da_equipe: notas } : {}),
  }
  const sql = !fonte && ds.transform_sql ? String(ds.transform_sql) : null
  return {
    dataset: slug,
    nome: ds.name,
    tipo: fonte ? 'fonte' : 'calculado',
    nome_no_sql: slug.replace(/-/g, '_'),
    ...(fonte && ds.object_name ? { tabela_de_origem: [ds.schema_name, ds.object_name].filter(Boolean).join('.') } : {}),
    linhas: perfil?.linhas ?? (ds.row_count == null ? null : Number(ds.row_count)),
    atualizado_em: ds.last_sync_at ?? null,
    descricao: ds.description || null,
    conhecimento,
    ...(perfil?.chave_provavel.length ? { chave_provavel: perfil.chave_provavel } : {}),
    ...(perfil?.erro ? { perfil_indisponivel: perfil.erro } : {}),
    campos,
    ...(sql ? {
      sql_do_calculo: sql.length > MAX_SQL_DO_CALCULO ? `${sql.slice(0, MAX_SQL_DO_CALCULO)}\n-- … (cortado)` : sql,
    } : {}),
  }
}

async function getSchema(slug: string, user: SessionUser): Promise<ToolOutcome> {
  const ds = await loadDataset(slug, user)
  const info = await conhecimentoDoConjunto(ds, { perfil: true })
  const metrics = (await db.query(
    `select slug, name, description, agg, field_key, format from metrics where dataset_id = $1`,
    [ds.id],
  )).rows
  // Mesmo uso que uma consulta: abrir o conjunto conta como usá-lo pela IA.
  await recordUsage({
    tenant: user.tenant, actor: user.email, resourceType: 'dataset', resourceId: String(ds.id), via: 'ai',
  })
  // `fields` continua com esse nome para o construtor de widgets, que lê só key e type.
  const { campos, ...resto } = info
  return { content: JSON.stringify({ ...resto, fields: campos, metrics }) }
}

async function executeQueryDef(def: QueryDef, user: SessionUser) {
  const ds = await loadDataset(def.dataset, user)
  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    throw new Error(`O conjunto "${def.dataset}" ainda não foi sincronizado com o lake.`)
  }
  const fields = (await db.query(
    `select key, type, sensitive from dataset_fields where dataset_id = $1 and not hidden`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean }[]
  const metrics = (await db.query(
    `select slug, agg, field_key as "fieldKey", filters from metrics where dataset_id = $1`,
    [ds.id],
  )).rows
  // SEMPRE como não-admin, inclusive para admin (D-SEG-4 do comitê, SEG-05):
  // tudo o que esta função devolve vai para o provedor de IA, fora da empresa.
  // O acesso continua sendo o do usuário (loadDataset); a máscara é que não
  // depende mais do papel — campo sensível sai mascarado e não serve de
  // filtro, agrupamento nem ordenação, como na API pública.
  const compiled = compileQuery(def, fields, {
    admin: false,
    glob: parquetGlob(dir),
    metrics: metrics as never,
  })
  const result = await duckQuery(compiled.sql, compiled.params, { timeoutMs: config.duck.queryTimeoutMs })
  // Uso (MON-01): a consulta é da IA, mas o acesso é da pessoa que perguntou.
  await recordUsage({
    tenant: user.tenant, actor: user.email, resourceType: 'dataset', resourceId: String(ds.id), via: 'ai',
    audit: { action: 'ai.query', resource: String(ds.slug) },
  })
  return result
}

// ── Valores de um campo ──────────────────────────────────────────────────
// Existe porque o agente garimpava conjuntos até esgotar as rodadas sem nunca
// achar o dado: a pergunta trazia "desbloqueio de confiança", e o que está
// gravado é ISA_DESBLOQUEIO_CONFIANÇA — com Ç, "_" e prefixo. O filtro
// "contém" ignora maiúscula mas não acento, e o catálogo só descreve campos,
// não os valores deles. Sem um jeito de VER os valores, a IA só podia chutar.

// Palavras que não ajudam a achar um valor e quebrariam o "todas as palavras".
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'no', 'na', 'para', 'por', 'com', 'os', 'as'])

/** "Desbloqueio de Confiança" → ['desbloqueio', 'confianca']: sem acento, sem caixa, sem pontuação. */
export function palavrasDeBusca(search: string): string[] {
  return search.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !PALAVRAS_VAZIAS.has(w))
}

// Fração de valores com "||" a partir da qual o campo é tratado como lista.
// É o formato das tags do Matrix ("A || B"); "||" quase nunca aparece em texto
// comum, então a detecção não confunde uma frase com uma lista.
const LIMIAR_LISTA = 0.05

async function listFieldValues(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const slug = String(input.dataset ?? '')
  const key = String(input.field ?? '')
  const search = input.search ? String(input.search).trim() : ''
  const ds = await loadDataset(slug, user)
  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    throw new Error(`O conjunto "${slug}" ainda não foi sincronizado com o lake.`)
  }
  const f = (await db.query(
    `select key, sensitive, hidden from dataset_fields where dataset_id = $1 and key = $2`,
    [ds.id, key],
  )).rows[0]
  if (!f || f.hidden) {
    return { content: `Campo não encontrado: ${key}. Use get_dataset_schema para ver os campos de ${slug}.`, isError: true }
  }
  // Nunca, nem para admin (SEG-05): o que esta função devolve vai para o
  // provedor de IA, fora da empresa — e a lista de valores de um CPF é o CPF.
  if (f.sensitive) {
    return { content: `O campo ${key} é sensível: os valores dele não são enviados à IA. Filtre ou agrupe por outro campo.`, isError: true }
  }

  const src = `read_parquet('${parquetGlob(dir)}')`
  const col = `"${key.replace(/"/g, '""')}"`
  const texto = `cast(${col} as varchar)`
  const opts = { timeoutMs: config.duck.queryTimeoutMs }

  let sep = input.separator ? String(input.separator) : null
  if (!sep) {
    const amostra = (await duckQuery(
      `select count(*) filter (where v like '%||%') as listas, count(*) as total
         from (select ${texto} as v from ${src} where ${col} is not null limit 5000)`, [], opts,
    )).rows[0]
    if (Number(amostra?.total ?? 0) > 0 && Number(amostra.listas) / Number(amostra.total) >= LIMIAR_LISTA) sep = '||'
  }

  // Lista na célula: desmonta, tira as aspas que o Matrix põe em volta e as
  // sobras de espaço. Cada linha conta uma vez por tag que tem. O unnest fica
  // sozinho no SELECT de dentro: dentro de outra função o DuckDB o recusa.
  const valores = sep
    ? `b as (select unnest(string_split(replace(${texto}, '"', ''), ?)) as t from ${src} where ${col} is not null),
          v as (select trim(t) as valor from b)`
    : `v as (select ${texto} as valor from ${src} where ${col} is not null)`
  const params: unknown[] = sep ? [sep] : []
  const palavras = palavrasDeBusca(search)
  const filtro = palavras.map((w) => { params.push(`%${w}%`); return `strip_accents(lower(valor)) like ?` })
  const { rows } = await duckQuery(
    `with ${valores},
          g as (select valor, count(*) as linhas from v
                 where valor <> ''${filtro.length ? ` and ${filtro.join(' and ')}` : ''}
                 group by valor)
     select valor, linhas, count(*) over () as distintos from g order by linhas desc, valor limit 50`,
    params, opts,
  )

  const values = rows.map((r) => ({ valor: r.valor, linhas: Number(r.linhas) }))
  const distintos = Number(rows[0]?.distintos ?? 0)
  let dica: string | undefined
  if (search && !values.length) {
    dica = 'Nenhum valor tem todas as palavras da busca. Tente uma palavra só (ex.: a raiz "desbloq") ou chame sem search para ver os mais comuns.'
  } else if (!sep && values.length && values.filter((v) => /[,;]/.test(String(v.valor))).length / values.length >= 0.3) {
    dica = 'Os valores parecem listas. Se forem, chame de novo com separator "," ou ";" para contar cada item.'
  } else if (distintos > values.length) {
    dica = `Mostrando os ${values.length} mais frequentes de ${distintos} valores distintos${search ? ' que casam com a busca' : ''}.`
  }
  return {
    content: JSON.stringify({
      dataset: slug, field: key, separator: sep, search: search || null, distintos, values,
      ...(dica ? { dica } : {}),
    }),
  }
}

async function runQuery(def: QueryDef, user: SessionUser): Promise<ToolOutcome> {
  const { rows } = await executeQueryDef({ ...def, limit: Math.min(def.limit ?? 100, 500) }, user)
  return { content: JSON.stringify({ rowCount: rows.length, rows: rows.slice(0, 100) }) }
}

// ── SQL livre (run_sql) ──────────────────────────────────────────────────
// A mesma preparação da célula do notebook (notebooksRouter.prepararCelula):
// conjuntos que a pessoa lê, validação pela árvore, projeção protegida. A única
// diferença é a máscara: aqui ela vale SEMPRE (admin: false), como no resto
// do que vai para a IA.
async function prepararSqlDaIa(user: SessionUser, sql: string, admin: boolean) {
  validateTransformSql(sql)
  await assertReferencesAllowed(user.tenant, sql, user)
  const refs = await lakeRefs(user.tenant, { user })
  return { refs, ...(await compileNotebookSql(sql, refs, { admin })) }
}

// Texto longo numa célula só gasta a leitura do modelo; o começo basta.
const MAX_CELULA = 300
function celulaCurta(v: unknown): unknown {
  return typeof v === 'string' && v.length > MAX_CELULA ? `${v.slice(0, MAX_CELULA - 1)}…` : v
}

async function runSql(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const sql = String(input.sql ?? '').trim()
  if (!sql) return { content: 'Informe a consulta em "sql".', isError: true }
  const max = config.ai.sqlMaxRows
  const inicio = Date.now()
  const { sql: wrapped, datasets, refs } = await prepararSqlDaIa(user, sql, false)
  let result
  try {
    // Uma linha a mais que o teto: é como se sabe que há mais sem contar tudo.
    result = await duckQuery(`select * from (${wrapped}) as __ia limit ${max + 1}`, [], {
      timeoutMs: config.duck.queryTimeoutMs, adhoc: true,
    })
  } catch (e) {
    throw friendlyDuckError(e as Error, refs)
  }
  for (const d of datasets) {
    if (!d.id) continue
    await recordUsage({
      tenant: user.tenant, actor: user.email, resourceType: 'dataset', resourceId: d.id, via: 'ai',
      audit: { action: 'ai.sql', resource: d.slug },
    })
  }
  const truncado = result.rows.length > max
  const linhas = (truncado ? result.rows.slice(0, max) : result.rows)
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, celulaCurta(v)])))
  return {
    content: JSON.stringify({
      colunas: result.columns,
      rowCount: linhas.length,
      truncado,
      ms: Date.now() - inicio,
      ...(truncado ? { aviso: `Só as primeiras ${max} linhas voltaram. Agregue no SQL (group by, count, sum) em vez de trazer linhas soltas.` } : {}),
      linhas,
    }),
  }
}

// ── Notebook com a análise (create_notebook) ─────────────────────────────
const MAX_CELULAS = 40

function slugDoNotebook(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'analise'
}

async function createNotebook(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const name = String(input.name ?? '').trim().slice(0, 120)
  if (!name) return { content: 'Informe o nome do notebook em "name".', isError: true }
  const brutas = Array.isArray(input.cells) ? (input.cells as Record<string, unknown>[]) : []
  const cells = brutas
    .map((c) => ({ kind: c.kind === 'sql' ? 'sql' : 'markdown', source: String(c.source ?? '').trim() }))
    .filter((c) => c.source)
  if (!cells.length) return { content: 'Informe as células em "cells".', isError: true }
  if (cells.length > MAX_CELULAS) return { content: `No máximo ${MAX_CELULAS} células.`, isError: true }

  // Toda célula SQL roda (uma linha) antes de salvar: notebook que abre com
  // erro é pior que nenhum. Roda com o papel real da pessoa — o notebook é
  // dela, e é com esse papel que ele vai rodar quando ela abrir.
  const erros: string[] = []
  for (const [i, c] of cells.entries()) {
    if (c.kind !== 'sql') continue
    try {
      const { sql: wrapped, refs } = await prepararSqlDaIa(user, c.source, user.roles.includes('admin'))
      try {
        await duckQuery(`select * from (${wrapped}) as __ia limit 1`, [], { timeoutMs: config.duck.queryTimeoutMs, adhoc: true })
      } catch (e) { throw friendlyDuckError(e as Error, refs) }
    } catch (e) {
      erros.push(`célula ${i + 1}: ${(e as Error).message}`)
    }
  }
  if (erros.length) {
    return { content: `Nada foi salvo. Corrija e chame de novo:\n- ${erros.join('\n- ')}`, isError: true }
  }

  const tenant = (await db.query('select id from tenants where slug = $1', [user.tenant])).rows[0]
  const taken = new Set((await db.query('select slug from notebooks where tenant_id = $1', [tenant.id])).rows.map((r) => String(r.slug)))
  const base = slugDoNotebook(name)
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  const comId = cells.map((c, i) => ({ id: `c${i + 1}`, kind: c.kind, source: c.source }))
  await db.query(
    `insert into notebooks (tenant_id, slug, name, description, cells, visibility, owner_email)
     values ($1,$2,$3,$4,$5,'private',$6)`,
    [tenant.id, slug, name, String(input.description ?? '').slice(0, 500), JSON.stringify(comId), user.email],
  )
  return {
    content: JSON.stringify({ ok: true, slug, link: `/notebooks/${slug}`, celulas: comId.length, visibilidade: 'privado (só a pessoa vê; ela pode compartilhar)' }),
    notebook: { slug, name },
  }
}

// Monta o MESMO QueryDef que o widget executará no frontend (fonte única da
// verdade para render_chart e propose_widgets).
function widgetSpecToQueryDef(
  type: string, slug: string, dimension: string | null,
  metric: Record<string, unknown>, filters: unknown,
): QueryDef {
  const metricSel = 'metric' in metric
    ? { metric: String(metric.metric), as: 'valor' }
    : { field: String(metric.field), agg: metric.agg as never, as: 'valor' }
  if (type === 'kpi') {
    return { dataset: slug, select: [metricSel as never], filters: (filters as never) ?? [], limit: 1 }
  }
  return {
    dataset: slug,
    select: [dimension!, metricSel as never],
    filters: (filters as never) ?? [],
    groupBy: [dimension!],
    orderBy: [{ field: type === 'line' || type === 'area' ? dimension! : 'valor', dir: type === 'line' || type === 'area' ? 'asc' : 'desc' }],
    limit: type === 'pie' ? 8 : 100,
  }
}

async function renderChart(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const type = String(input.type)
  const slug = String(input.dataset)
  const dimension = input.dimension ? String(input.dimension) : null
  const metric = input.metric as Record<string, unknown>
  if (type !== 'kpi' && !dimension) {
    return { content: 'Gráficos (exceto kpi) exigem dimension.', isError: true }
  }
  const def = widgetSpecToQueryDef(type, slug, dimension, metric, input.filters)
  const { rows } = await executeQueryDef(def, user)
  const chart = {
    type, title: String(input.title ?? ''), datasetSlug: slug,
    dimension, metric, filters: input.filters ?? [],
  }
  return {
    content: `Gráfico exibido ao usuário (${rows.length} ponto(s) de dados).`,
    chart,
  }
}

const WIDGET_TYPES = new Set(['kpi', 'line', 'bar', 'pie', 'area', 'table'])

// Valida UM widget proposto: tipo/dimensão coerentes, conjunto acessível e a
// consulta REALMENTE roda (campos existem, está sincronizado). Devolve o widget
// normalizado (com datasetId, para o POST /widgets) ou uma mensagem de erro.
async function validateSpec(
  spec: Record<string, unknown>, user: SessionUser,
): Promise<{ ok: true; widget: Record<string, unknown> } | { ok: false; error: string }> {
  const type = String(spec.type ?? '')
  if (!WIDGET_TYPES.has(type)) return { ok: false, error: `tipo inválido "${type}"` }
  const slug = String(spec.dataset ?? spec.datasetSlug ?? '')
  if (!slug) return { ok: false, error: 'conjunto (dataset) ausente' }
  const dimension = spec.dimension ? String(spec.dimension) : null
  const metric = spec.metric as Record<string, unknown> | undefined
  if (!metric) return { ok: false, error: 'métrica ausente' }
  if (type !== 'kpi' && !dimension) return { ok: false, error: `o widget "${spec.title || type}" precisa de dimension` }
  try {
    const ds = await loadDataset(slug, user)
    const def = widgetSpecToQueryDef(type, slug, dimension, metric, spec.filters)
    await executeQueryDef(def, user) // lança se um campo não existe ou não há dados
    return {
      ok: true,
      widget: {
        type, title: String(spec.title ?? ''), datasetSlug: slug, datasetId: String(ds.id),
        dimension, metric, filters: spec.filters ?? [], style: spec.style ?? null,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function proposeWidgets(input: Record<string, unknown>, user: SessionUser): Promise<ToolOutcome> {
  const specs = Array.isArray(input.widgets) ? (input.widgets as Record<string, unknown>[]) : []
  if (!specs.length) return { content: 'Informe ao menos um widget em "widgets".', isError: true }
  const valid: Record<string, unknown>[] = []
  const errors: string[] = []
  for (const [i, s] of specs.entries()) {
    const r = await validateSpec(s, user)
    if (r.ok) valid.push(r.widget)
    else errors.push(`widget ${i + 1} (${s.title || s.type || '?'}): ${r.error}`)
  }
  if (errors.length) {
    return {
      content: `Alguns widgets são inválidos — corrija (use get_dataset_schema para os campos certos) e chame propose_widgets de novo:\n- ${errors.join('\n- ')}`,
      isError: true,
    }
  }
  return { content: `${valid.length} widget(s) validado(s) e proposto(s) ao usuário.`, widgets: valid }
}
