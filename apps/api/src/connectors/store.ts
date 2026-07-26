// Conexões GERENCIADAS: leitura do banco de metadados → registry (em memória),
// e CRUD. A senha é criptografada em repouso (crypto.ts) e só descriptografada
// aqui, para popular o `config` do conector. Ao editar/excluir, a pool em cache
// é invalidada para reconectar com os novos parâmetros.
import { db, isDbAvailable } from '../db/pool.js'
import { decryptSecret, encryptSecret, hasSecret } from '../core/crypto.js'
import { setDynamicConnectors, RESERVED_IDS, type ConnectorDef } from './registry.js'
import { resetPool } from './pools.js'

export interface ConnectionInput {
  name: string
  kind: 'postgres' | 'mysql'
  host: string
  port: number
  database: string
  username: string
  password?: string // ausente no update = mantém a atual
  ssl: boolean
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acentos
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'conexao'
}

// (Re)carrega as conexões gerenciadas do banco para o registry em memória.
export async function reloadConnections(): Promise<void> {
  if (!isDbAvailable() || !hasSecret()) return // sem chave não dá pra descriptografar
  const rows = (await db.query('select * from source_connections')).rows
  const defs: ConnectorDef[] = []
  for (const r of rows) {
    try {
      defs.push({
        id: r.id, name: r.name, kind: r.kind, managed: true,
        config: {
          host: r.host, port: r.port, database: r.database,
          user: r.username, password: decryptSecret(r.password_enc), ssl: r.ssl,
        },
      })
    } catch (e) {
      console.warn(`[connections] falha ao carregar "${r.id}": ${(e as Error).message}`)
    }
  }
  setDynamicConnectors(defs)
}

async function uniqueId(base: string): Promise<string> {
  let id = base
  let n = 1
  for (;;) {
    const taken = RESERVED_IDS.has(id) ||
      !!(await db.query('select 1 from source_connections where id = $1', [id])).rows[0]
    if (!taken) return id
    id = `${base}-${++n}`
  }
}

export async function createConnection(input: ConnectionInput, byEmail: string): Promise<string> {
  if (!input.password) throw new Error('Senha obrigatória para criar uma conexão.')
  const id = await uniqueId(slugify(input.name))
  await db.query(
    `insert into source_connections (id, name, kind, host, port, "database", username, password_enc, ssl, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.name, input.kind, input.host, input.port, input.database, input.username,
     encryptSecret(input.password), input.ssl, byEmail],
  )
  await reloadConnections()
  return id
}

export async function updateConnection(id: string, input: ConnectionInput): Promise<void> {
  const cur = (await db.query('select 1 from source_connections where id = $1', [id])).rows[0]
  if (!cur) throw new Error('Conexão gerenciada não encontrada.')
  const pwd = input.password ? encryptSecret(input.password) : null // branco = mantém
  await db.query(
    `update source_connections set name=$2, kind=$3, host=$4, port=$5, "database"=$6, username=$7,
       password_enc = coalesce($8, password_enc), ssl=$9, updated_at=now() where id=$1`,
    [id, input.name, input.kind, input.host, input.port, input.database, input.username, pwd, input.ssl],
  )
  resetPool(id)
  await reloadConnections()
}

export async function deleteConnection(id: string): Promise<void> {
  await db.query('delete from source_connections where id = $1', [id])
  resetPool(id)
  await reloadConnections()
}

// Quantos datasets usam esta conexão (para avisar antes de excluir).
export async function datasetsUsing(id: string): Promise<number> {
  const r = (await db.query('select count(*)::int as n from datasets where connection_id = $1', [id])).rows[0]
  return Number(r?.n ?? 0)
}
