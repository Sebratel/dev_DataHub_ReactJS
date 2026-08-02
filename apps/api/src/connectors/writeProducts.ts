// Fase 4: executor de PRODUTOS DE ESCRITA. Monta um INSERT PARAMETRIZADO a
// partir da definição do ADMIN (schema/tabela/colunas permitidas) e dos VALORES
// do consumidor. Segurança:
//   • Nomes (schema/tabela/coluna) vêm da definição (confiáveis) e são citados.
//   • Colunas fora da allowlist são IGNORADAS (o consumidor não escolhe coluna).
//   • Valores vão como PARÂMETROS ($1/?) — nunca concatenados → à prova de injection.
//   • Obrigatórios são validados; números/booleanos coeridos.
import { execSource } from './pools.js'
import { getConnector } from './registry.js'

export interface WriteColumn {
  col: string
  type: 'text' | 'number' | 'bool' | 'date'
  required?: boolean
}

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

export function buildInsert(
  kind: 'postgres' | 'mysql',
  schema: string, table: string, columns: WriteColumn[], body: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  for (const c of columns) {
    if (c.required && (body[c.col] === undefined || body[c.col] === null || body[c.col] === '')) {
      throw new Error(`Campo obrigatório ausente: "${c.col}".`)
    }
  }
  const used = columns.filter((c) => body[c.col] !== undefined) // só allowlist + enviados
  if (!used.length) throw new Error('Nenhum valor válido enviado (verifique os campos permitidos).')

  const q = kind === 'mysql'
    ? (s: string) => '`' + String(s).replace(/`/g, '') + '`'
    : (s: string) => '"' + String(s).replace(/"/g, '""') + '"'
  const ph = (i: number) => (kind === 'mysql' ? '?' : `$${i + 1}`)

  const params = used.map((c) => coerce(c.type, body[c.col]))
  const cols = used.map((c) => q(c.col)).join(', ')
  const values = used.map((_, i) => ph(i)).join(', ')
  const returning = kind === 'postgres' ? ' returning *' : ''
  return { sql: `insert into ${q(schema)}.${q(table)} (${cols}) values (${values})${returning}`, params }
}

// Valida o body e executa o INSERT na conexão gravável do produto.
export async function executeWriteInsert(
  product: { connectionId: string; schema: string; table: string; columns: WriteColumn[] },
  body: Record<string, unknown>,
): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  const def = getConnector(product.connectionId)
  if (!def) throw new Error('Conexão da API de escrita não encontrada.')
  if (def.kind !== 'postgres' && def.kind !== 'mysql') throw new Error('Conexão inválida para escrita.')
  const { sql, params } = buildInsert(def.kind, product.schema, product.table, product.columns, body)
  return execSource(product.connectionId, sql, params)
}
