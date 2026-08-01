// Conexões GERENCIADAS: leitura do banco de metadados → registry (em memória),
// e CRUD. A senha é criptografada em repouso (crypto.ts) e só descriptografada
// aqui, para popular o `config` do conector. Ao editar/excluir, a pool em cache
// é invalidada para reconectar com os novos parâmetros.
import { db, isDbAvailable } from '../db/pool.js'
import { decryptSecret, encryptSecret, hasSecret } from '../core/crypto.js'
import { setDynamicConnectors, RESERVED_IDS, envPassword, type ConnectorDef } from './registry.js'
import { resetPool } from './pools.js'

export interface ConnectionInput {
  name: string
  kind: 'postgres' | 'mysql' | 'http'
  ssl: boolean
  // SQL (postgres/mysql)
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string // ausente no update = mantém a atual
  // HTTP (API GET)
  baseUrl?: string
  authHeader?: string
  authScheme?: string
  token?: string // ausente no update = mantém o atual
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
      if (r.kind === 'http') {
        const cfg = (r.config ?? {}) as { baseUrl?: string; authHeader?: string; authScheme?: string }
        defs.push({
          id: r.id, name: r.name, kind: 'http', managed: true,
          http: {
            baseUrl: cfg.baseUrl ?? '', authHeader: cfg.authHeader || undefined, authScheme: cfg.authScheme || undefined,
            token: r.password_enc ? decryptSecret(r.password_enc) : undefined,
          },
        })
      } else {
        defs.push({
          id: r.id, name: r.name, kind: r.kind, managed: true,
          config: {
            host: r.host, port: r.port, database: r.database,
            user: r.username, password: decryptSecret(r.password_enc), ssl: r.ssl,
          },
        })
      }
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

// Colunas específicas por tipo: SQL usa host/porta/etc.; HTTP usa config jsonb
// (baseUrl/header) e o "secret" é o token. Retorna também o segredo em claro.
function rowValues(input: ConnectionInput): {
  host: string | null; port: number | null; database: string | null; username: string | null
  config: string | null; secret?: string
} {
  if (input.kind === 'http') {
    return {
      host: null, port: null, database: null, username: null,
      config: JSON.stringify({ baseUrl: input.baseUrl, authHeader: input.authHeader || null, authScheme: input.authScheme || null }),
      secret: input.token,
    }
  }
  return {
    host: input.host ?? '', port: input.port ?? 0, database: input.database ?? '', username: input.username ?? '',
    config: null, secret: input.password,
  }
}

export async function createConnection(input: ConnectionInput, byEmail: string): Promise<string> {
  const v = rowValues(input)
  if (input.kind !== 'http' && !v.secret) throw new Error('Senha obrigatória para criar uma conexão de banco.')
  const id = await uniqueId(slugify(input.name))
  await db.query(
    `insert into source_connections (id, name, kind, host, port, "database", username, password_enc, ssl, config, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, input.name, input.kind, v.host, v.port, v.database, v.username,
     v.secret ? encryptSecret(v.secret) : null, input.ssl, v.config, byEmail],
  )
  await reloadConnections()
  return id
}

// Upsert: edita uma gerenciada existente OU cria a SOBREPOSIÇÃO de uma nativa.
// Senha em branco: mantém a atual (se já existe) ou semeia a do .env (1ª
// personalização de uma nativa). Só pede senha se não há nenhuma para reusar.
export async function updateConnection(id: string, input: ConnectionInput, byEmail: string): Promise<void> {
  const exists = !!(await db.query('select 1 from source_connections where id = $1', [id])).rows[0]
  const v = rowValues(input)
  let pwdEnc: string | null
  if (v.secret) pwdEnc = encryptSecret(v.secret)
  else if (exists) pwdEnc = null // coalesce mantém o atual
  else if (input.kind === 'http') pwdEnc = null // http pode não ter token
  else {
    const seed = envPassword(id) // personalizando uma nativa: reaproveita a senha do .env
    if (!seed) throw new Error('Informe a senha (não há senha do .env para reaproveitar).')
    pwdEnc = encryptSecret(seed)
  }
  if (exists) {
    await db.query(
      `update source_connections set name=$2, kind=$3, host=$4, port=$5, "database"=$6, username=$7,
         password_enc = coalesce($8, password_enc), ssl=$9, config=$10, updated_at=now() where id=$1`,
      [id, input.name, input.kind, v.host, v.port, v.database, v.username, pwdEnc, input.ssl, v.config],
    )
  } else {
    await db.query(
      `insert into source_connections (id, name, kind, host, port, "database", username, password_enc, ssl, config, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, input.name, input.kind, v.host, v.port, v.database, v.username, pwdEnc, input.ssl, v.config, byEmail],
    )
  }
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
