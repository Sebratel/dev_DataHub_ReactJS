// ─────────────────────────────────────────────────────────────────────────
// Introspecção de CHAVES e ÍNDICES da tabela de origem.
//
// A descoberta que já existia (discoverColumns) só sabe nome, tipo e nulidade
// — o suficiente para publicar um conjunto, e insuficiente para decidir a
// regra de atualização incremental dele. Faltavam as duas coisas que essa
// decisão exige:
//
//   • IDENTIDADE da linha (chave primária / índice único) — sem ela, o
//     incremental não tem como saber que a linha que chegou agora é a MESMA
//     que já está no lake, e a versão antiga fica convivendo com a nova.
//   • COBERTURA DE ÍNDICE da chave incremental — uma passada keyset
//     (`where created > $1 order by created limit n`) só é barata se `created`
//     for a coluna PRINCIPAL de algum índice. Sem índice, cada lote vira uma
//     varredura completa da tabela, contra a produção. Num agendamento de 5 em
//     5 minutos, isso é 288 varreduras por dia por conjunto — é exatamente o
//     jeito de derrubar o servidor de origem achando que se está fazendo
//     ingestão leve.
//
// Tudo aqui é SELECT em catálogo do próprio banco (information_schema e, no
// Postgres, pg_indexes) — passa pelo guard read-only como qualquer consulta.
// ─────────────────────────────────────────────────────────────────────────
import { getConnector } from './registry.js'
import { querySource } from './pools.js'

export interface IndexInfo {
  name: string
  unique: boolean
  primary: boolean
  /** Colunas na ORDEM do índice — a 1ª é a que serve de chave keyset. */
  columns: string[]
}

export interface TableKeys {
  /** Colunas da chave primária, em ordem. Vazio em view ou tabela sem PK. */
  primaryKey: string[]
  /** Índices ÚNICOS (inclui o da PK), da menor para a maior aridade. */
  uniques: IndexInfo[]
  /** Todos os índices lidos. */
  indexes: IndexInfo[]
  /** Colunas que são a PRIMEIRA de algum índice — as que servem de keyset. */
  leadingColumns: Set<string>
  /** true quando o objeto é uma view: não tem índice nem PK para ler. */
  isView: boolean
  /** Preenchido quando a leitura do catálogo falhou (permissão, dialeto). */
  error?: string
}

const EMPTY = (over: Partial<TableKeys> = {}): TableKeys => ({
  primaryKey: [], uniques: [], indexes: [], leadingColumns: new Set(), isView: false, ...over,
})

// O indexdef do Postgres vem como texto pronto:
//   CREATE UNIQUE INDEX x ON public.t USING btree (a, lower(b)) WHERE ativo
// Interessa a lista entre parênteses DEPOIS do "USING <método>", parando antes
// de um WHERE de índice parcial. Expressões (lower(b), (a || b)) são
// descartadas: uma passada keyset precisa da COLUNA nua para o `order by`
// usar o índice — indexar uma expressão não ajuda a ordenar pela coluna.
// Exportado com nome próprio só para o smoke: é a única peça aqui que não
// precisa de conexão para ser exercitada, e é a mais fácil de quebrar em
// silêncio (texto livre do Postgres).
export { parsePgIndexDef as parseIndexDefForTest }
function parsePgIndexDef(def: string): { unique: boolean; columns: string[] } | null {
  const m = /\susing\s+\w+\s*\(([\s\S]+)\)/i.exec(def)
  if (!m) return null
  // Corta um eventual "WHERE ..." que tenha entrado no grupo por causa de
  // parênteses aninhados: pega só até o fecha-parênteses equilibrado.
  let depth = 0
  let list = ''
  for (const ch of m[1]) {
    if (ch === '(') depth++
    if (ch === ')') { if (depth === 0) break; depth-- }
    list += ch
  }
  const columns: string[] = []
  let buf = ''
  depth = 0
  for (const ch of list + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { columns.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  const clean = columns
    // "col DESC NULLS LAST", "col text_pattern_ops" → fica só o 1º token.
    .map((c) => c.replace(/"/g, '').trim().split(/\s+/)[0])
    // Expressão ou função: não serve de chave keyset.
    .filter((c) => c && !c.includes('(') && !c.includes('|'))
  if (!clean.length) return null
  return { unique: /^\s*create\s+unique\s+index/i.test(def), columns: clean }
}

async function pgKeys(connectorId: string, schema: string, table: string): Promise<TableKeys> {
  // É view? View não tem índice nem PK — sem isto, "nenhum índice encontrado"
  // seria lido como "tabela sem índice", que é um diagnóstico diferente.
  const kind = (await querySource(
    connectorId,
    `select table_type from information_schema.tables where table_schema = $1 and table_name = $2`,
    [schema, table],
  )).rows[0]
  const isView = String(kind?.table_type ?? '').toLowerCase().includes('view')

  // PK pelo information_schema (autoritativo e portável). O ordinal_position do
  // key_column_usage dá a ORDEM das colunas dentro da chave, que importa.
  const pk = (await querySource(
    connectorId,
    `select kcu.column_name, kcu.ordinal_position
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
      where tc.table_schema = $1 and tc.table_name = $2
        and tc.constraint_type = 'PRIMARY KEY'
      order by kcu.ordinal_position`,
    [schema, table],
  )).rows.map((r) => String(r.column_name))

  // Índices: pg_indexes traz o DDL pronto, de onde saem unicidade e colunas.
  const defs = (await querySource(
    connectorId,
    `select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = $2`,
    [schema, table],
  )).rows

  const indexes: IndexInfo[] = []
  for (const d of defs) {
    const parsed = parsePgIndexDef(String(d.indexdef))
    if (!parsed) continue
    const name = String(d.indexname)
    indexes.push({
      name, unique: parsed.unique, columns: parsed.columns,
      // PK e índice-da-PK têm o mesmo conjunto de colunas; marcar por comparação
      // é mais confiável que confiar no sufixo "_pkey" do nome.
      primary: pk.length > 0 && parsed.columns.length === pk.length
        && parsed.columns.every((c, i) => c === pk[i]),
    })
  }
  return buildKeys(pk, indexes, isView)
}

async function mysqlKeys(connectorId: string, schema: string, table: string): Promise<TableKeys> {
  const kind = (await querySource(
    connectorId,
    `select table_type from information_schema.tables where table_schema = ? and table_name = ?`,
    [schema, table],
  )).rows[0]
  const isView = String(kind?.table_type ?? '').toLowerCase().includes('view')

  // information_schema.statistics é a fonte única no MySQL/MariaDB: uma linha
  // por COLUNA de cada índice, com a posição dentro dele (seq_in_index) e o
  // non_unique invertido. PRIMARY é o nome reservado do índice da PK.
  const rows = (await querySource(
    connectorId,
    `select index_name, seq_in_index, column_name, non_unique
       from information_schema.statistics
      where table_schema = ? and table_name = ?
      order by index_name, seq_in_index`,
    [schema, table],
  )).rows

  const byIndex = new Map<string, IndexInfo>()
  for (const r of rows) {
    const name = String(r.index_name)
    // Índice sobre expressão (MariaDB 10.5+/MySQL 8): column_name vem NULL.
    // Mesma regra do Postgres — não serve de chave keyset.
    if (r.column_name == null) continue
    const entry = byIndex.get(name) ?? {
      name, unique: Number(r.non_unique) === 0, primary: name === 'PRIMARY', columns: [],
    }
    entry.columns.push(String(r.column_name))
    byIndex.set(name, entry)
  }
  const indexes = [...byIndex.values()]
  const pk = indexes.find((i) => i.primary)?.columns ?? []
  return buildKeys(pk, indexes, isView)
}

function buildKeys(primaryKey: string[], indexes: IndexInfo[], isView: boolean): TableKeys {
  const uniques = indexes
    .filter((i) => i.unique)
    // Menor aridade primeiro: uma identidade de 1 coluna é sempre preferível a
    // uma composta de 4 — menos campo para casar e compactação mais barata.
    .sort((a, b) => a.columns.length - b.columns.length)
  const leadingColumns = new Set(indexes.map((i) => i.columns[0]).filter(Boolean))
  return { primaryKey, uniques, indexes, leadingColumns, isView }
}

// Lê PK/índices do objeto físico. NUNCA lança: a análise de dezenas de
// conjuntos não pode parar porque um deles está numa fonte fora do ar ou num
// usuário sem permissão de ler o catálogo — esse conjunto volta com `error` e
// o diagnóstico dele sai como "não foi possível analisar".
export async function discoverKeys(
  connectorId: string, schema: string, table: string,
): Promise<TableKeys> {
  const def = getConnector(connectorId)
  if (!def) return EMPTY({ error: `Fonte desconhecida: ${connectorId}` })
  try {
    if (def.kind === 'postgres') return await pgKeys(connectorId, schema, table)
    if (def.kind === 'mysql') return await mysqlKeys(connectorId, schema, table)
    return EMPTY({ error: `Fonte "${connectorId}" (${def.kind}) não expõe catálogo de índices.` })
  } catch (e) {
    return EMPTY({ error: (e as Error).message })
  }
}
