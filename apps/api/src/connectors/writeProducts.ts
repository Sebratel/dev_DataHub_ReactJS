// Executor de ESCRITA dos produtos de API. Monta INSERT / UPDATE / DELETE
// PARAMETRIZADOS a partir da definição (schema/tabela/colunas/chaves permitidas)
// e dos VALORES do consumidor. Segurança (nível sênior):
//   • Nomes (schema/tabela/coluna/chave) vêm da definição (confiáveis) e são citados.
//   • Colunas/chaves fora da allowlist são IGNORADAS (o consumidor não escolhe coluna).
//   • Valores vão como PARÂMETROS ($1/?) — nunca concatenados → à prova de injection.
//   • UPDATE/DELETE EXIGEM ao menos um filtro (WHERE) — jamais varrem a tabela inteira.
//   • max_affected: a operação roda em TRANSAÇÃO e faz ROLLBACK se exceder o teto.
import type { ApiWriteOp } from '@datahub/shared'
import { execSource, execSourceGuarded } from './pools.js'
import { getConnector } from './registry.js'

export interface WriteColumn {
  col: string
  type: 'text' | 'number' | 'bool' | 'date'
  required?: boolean
}

type Kind = 'postgres' | 'mysql'

function coerce(type: WriteColumn['type'], v: unknown): unknown {
  if (v === null) return null
  if (type === 'number') {
    const n = Number(v)
    if (Number.isNaN(n)) throw new Error(`Valor numérico inválido para uma coluna: "${String(v)}".`)
    return n
  }
  if (type === 'bool') return v === true || v === 'true' || v === 1 || v === '1'
  return String(v) // text/date — o driver converte a string
}

const quoter = (kind: Kind) => kind === 'mysql'
  ? (s: string) => '`' + String(s).replace(/`/g, '') + '`'
  : (s: string) => '"' + String(s).replace(/"/g, '""') + '"'

// Gerador de placeholders posicional ($1,$2… no pg; ? no mysql) e coerência
// com a ORDEM em que empurramos os params.
function placeholders(kind: Kind) {
  let i = 0
  return () => (kind === 'mysql' ? '?' : `$${++i}`)
}

// Só as colunas da allowlist E enviadas (undefined = não mexe).
function present(cols: WriteColumn[], body: Record<string, unknown>): WriteColumn[] {
  return cols.filter((c) => body[c.col] !== undefined)
}
// Para WHERE: também descarta null/'' (um filtro vazio não é filtro).
function presentKeys(cols: WriteColumn[], body: Record<string, unknown>): WriteColumn[] {
  return cols.filter((c) => body[c.col] !== undefined && body[c.col] !== null && body[c.col] !== '')
}

export function buildInsert(
  kind: Kind, schema: string, table: string, columns: WriteColumn[], body: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  for (const c of columns) {
    if (c.required && (body[c.col] === undefined || body[c.col] === null || body[c.col] === '')) {
      throw new Error(`Campo obrigatório ausente: "${c.col}".`)
    }
  }
  const used = present(columns, body)
  if (!used.length) throw new Error('Nenhum valor válido enviado (verifique os campos permitidos).')
  const q = quoter(kind)
  const ph = placeholders(kind)
  const params = used.map((c) => coerce(c.type, body[c.col]))
  const cols = used.map((c) => q(c.col)).join(', ')
  const values = used.map(() => ph()).join(', ')
  const returning = kind === 'postgres' ? ' returning *' : ''
  return { sql: `insert into ${q(schema)}.${q(table)} (${cols}) values (${values})${returning}`, params }
}

export function buildUpdate(
  kind: Kind, schema: string, table: string,
  setColumns: WriteColumn[], keyColumns: WriteColumn[],
  setBody: Record<string, unknown>, whereBody: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  const setUsed = present(setColumns, setBody)
  if (!setUsed.length) throw new Error('Nenhum campo para atualizar (set) foi enviado.')
  const whereUsed = presentKeys(keyColumns, whereBody)
  if (!whereUsed.length) {
    throw new Error('Informe ao menos um filtro (where) — um UPDATE sem filtro afetaria a tabela inteira.')
  }
  const q = quoter(kind)
  const ph = placeholders(kind)
  // Ordem dos params: primeiro os SET, depois os WHERE (mesma ordem das cláusulas).
  const params = [
    ...setUsed.map((c) => coerce(c.type, setBody[c.col])),
    ...whereUsed.map((c) => coerce(c.type, whereBody[c.col])),
  ]
  const setSql = setUsed.map((c) => `${q(c.col)} = ${ph()}`).join(', ')
  const whereSql = whereUsed.map((c) => `${q(c.col)} = ${ph()}`).join(' and ')
  const returning = kind === 'postgres' ? ' returning *' : ''
  return { sql: `update ${q(schema)}.${q(table)} set ${setSql} where ${whereSql}${returning}`, params }
}

export function buildDelete(
  kind: Kind, schema: string, table: string,
  keyColumns: WriteColumn[], whereBody: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  const whereUsed = presentKeys(keyColumns, whereBody)
  if (!whereUsed.length) {
    throw new Error('Informe ao menos um filtro (where) — um DELETE sem filtro apagaria a tabela inteira.')
  }
  const q = quoter(kind)
  const ph = placeholders(kind)
  const params = whereUsed.map((c) => coerce(c.type, whereBody[c.col]))
  const whereSql = whereUsed.map((c) => `${q(c.col)} = ${ph()}`).join(' and ')
  const returning = kind === 'postgres' ? ' returning *' : ''
  return { sql: `delete from ${q(schema)}.${q(table)} where ${whereSql}${returning}`, params }
}

export interface WriteDef {
  op: ApiWriteOp
  connectionId: string
  schema: string
  table: string
  columns: WriteColumn[]      // SET/body
  keyColumns: WriteColumn[]   // WHERE
  maxAffected?: number | null
}
export interface WritePayload {
  values?: Record<string, unknown> // insert (flat)
  set?: Record<string, unknown>    // update
  where?: Record<string, unknown>  // update/delete
}

// Monta o SQL da operação. Exposto para o DRY-RUN do "Testar" (não executa).
export function buildWriteSql(def: WriteDef, kind: Kind, payload: WritePayload) {
  if (def.op === 'insert') return buildInsert(kind, def.schema, def.table, def.columns, payload.values ?? payload.set ?? {})
  if (def.op === 'update') return buildUpdate(kind, def.schema, def.table, def.columns, def.keyColumns, payload.set ?? {}, payload.where ?? {})
  return buildDelete(kind, def.schema, def.table, def.keyColumns, payload.where ?? {})
}

// Executa a operação na conexão gravável. INSERT direto; UPDATE/DELETE em
// transação com teto de linhas (rollback se exceder).
export async function executeWrite(def: WriteDef, payload: WritePayload): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  const conn = getConnector(def.connectionId)
  if (!conn) throw new Error('Conexão da API de escrita não encontrada.')
  if (conn.kind !== 'postgres' && conn.kind !== 'mysql') throw new Error('Conexão inválida para escrita.')
  const { sql, params } = buildWriteSql(def, conn.kind, payload)
  if (def.op === 'insert') return execSource(def.connectionId, sql, params)
  return execSourceGuarded(def.connectionId, sql, params, def.maxAffected ?? null)
}
