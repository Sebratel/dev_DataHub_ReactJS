// Pools de conexão por fonte — lazy, pequenos e somente-leitura por contrato.
// Pool ≤ 3 conexões e statement_timeout de 120 s: a ingestão jamais pode pesar
// nos bancos de produção (docs §9.1). Portado do padrão makePool do churn_mvp.
import pg from 'pg'
import mysql from 'mysql2/promise'
import { CONNECTORS, getConnector, isConfigured, type ConnectorDef } from './registry.js'
import { assertReadOnly } from '../core/guard.js'
import { config } from '../core/config.js'
import { testHttp } from './httpSource.js'

const { Pool } = pg

const pgPools = new Map<string, pg.Pool>()
const mysqlPools = new Map<string, mysql.Pool>()

function env(def: ConnectorDef, suffix: string): string | undefined {
  return process.env[`${def.envPrefix}_${suffix}`]
}

function requireConfigured(def: ConnectorDef): void {
  if (!isConfigured(def)) {
    throw new Error(`Fonte "${def.id}" sem credenciais (${def.envPrefix ? def.envPrefix + '_*' : 'conexão gerenciada'}).`)
  }
}

// Resolve os parâmetros de conexão: fontes GERENCIADAS trazem `config` (senha já
// descriptografada em memória); fontes FIXAS leem do .env pelo prefixo.
function resolveConfig(def: ConnectorDef, defaultPort: number) {
  if (def.config) {
    return {
      host: def.config.host, port: def.config.port || defaultPort,
      database: def.config.database, user: def.config.user,
      password: def.config.password, ssl: def.config.ssl,
    }
  }
  return {
    host: env(def, 'HOST'), port: Number(env(def, 'PORT')) || defaultPort,
    database: env(def, 'DATABASE'), user: env(def, 'USER'),
    password: env(def, 'PASSWORD'), ssl: env(def, 'SSL') === 'true',
  }
}

// Encerra e descarta a pool em cache (ex.: após editar/excluir a conexão) para
// que a próxima consulta reconecte com os novos parâmetros.
export function resetPool(id: string): void {
  const pg = pgPools.get(id); if (pg) { pgPools.delete(id); void pg.end().catch(() => {}) }
  const my = mysqlPools.get(id); if (my) { mysqlPools.delete(id); void my.end().catch(() => {}) }
}

function getPgPool(def: ConnectorDef): pg.Pool {
  let pool = pgPools.get(def.id)
  if (pool) return pool
  requireConfigured(def)
  const c = resolveConfig(def, 5432)
  pool = new Pool({
    host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
    max: 3,
    connectionTimeoutMillis: 15_000,
    statement_timeout: config.sources.statementTimeoutMs,
  })
  pgPools.set(def.id, pool)
  return pool
}

function getMysqlPool(def: ConnectorDef): mysql.Pool {
  let pool = mysqlPools.get(def.id)
  if (pool) return pool
  requireConfigured(def)
  const c = resolveConfig(def, 3306)
  pool = mysql.createPool({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    connectionLimit: 3,
    connectTimeout: 15_000,
    dateStrings: true,
  })
  // Teto de execução por consulta NO SERVIDOR de origem (o MySQL não tem
  // statement_timeout como o Postgres). MySQL usa max_execution_time (ms, só
  // SELECT); MariaDB usa max_statement_time (segundos). Setamos as duas em cada
  // nova conexão e ignoramos o erro da variável que não existir no servidor.
  const ms = config.sources.statementTimeoutMs
  const sec = Math.max(1, Math.ceil(ms / 1000))
  type RawConn = { query: (sql: string, cb: (err: unknown) => void) => void }
  ;(pool as unknown as { on(ev: 'connection', cb: (c: RawConn) => void): void }).on(
    'connection',
    (conn) => {
      conn.query(`set session max_execution_time = ${ms}`, () => { /* MySQL; ignora se não existir */ })
      conn.query(`set session max_statement_time = ${sec}`, () => { /* MariaDB; ignora se não existir */ })
    },
  )
  mysqlPools.set(def.id, pool)
  return pool
}

// Executa um SELECT (validado pelo guard) na fonte. Uso interno: descoberta de
// tabelas e ingestão. Nunca exposto cru ao usuário final.
export async function querySource(
  connectorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  const def = getConnector(connectorId)
  if (!def) throw new Error(`Fonte desconhecida: ${connectorId}`)
  assertReadOnly(sql)
  if (def.kind === 'postgres') {
    const res = await getPgPool(def).query(sql, params as never[])
    return { rows: res.rows }
  }
  if (def.kind === 'mysql') {
    const [rows] = await getMysqlPool(def).query(sql, params)
    return { rows: rows as Record<string, unknown>[] }
  }
  throw new Error(`Fonte "${connectorId}" (${def.kind}) não suporta SQL.`)
}

// Testa PARÂMETROS avulsos (antes de salvar) com uma conexão descartável.
export async function testParams(input: {
  kind: 'postgres' | 'mysql'; host: string; port: number; database: string
  user: string; password: string; ssl: boolean
}): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    if (input.kind === 'postgres') {
      const client = new pg.Client({
        host: input.host, port: input.port, database: input.database,
        user: input.user, password: input.password,
        ssl: input.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10_000, statement_timeout: 10_000,
      })
      await client.connect()
      try { await client.query('select 1') } finally { await client.end() }
    } else {
      const conn = await mysql.createConnection({
        host: input.host, port: input.port, database: input.database,
        user: input.user, password: input.password,
        ssl: input.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10_000,
      })
      try { await conn.query('select 1') } finally { await conn.end() }
    }
    return { ok: true, latencyMs: Date.now() - started }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: (e as Error).message }
  }
}

// ESCRITA (Fase 4): executa uma mutação parametrizada numa conexão GRAVÁVEL.
// É o ÚNICO caminho que NÃO passa pelo guard read-only — e só funciona em
// conexões explicitamente marcadas como writable. Uso exclusivo do executor de
// produtos de escrita (o SQL é montado pelo servidor; o consumidor só dá valores).
export async function execSource(
  connectorId: string, sql: string, params: unknown[] = [],
): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  const def = getConnector(connectorId)
  if (!def) throw new Error(`Fonte desconhecida: ${connectorId}`)
  if (!def.writable) throw new Error(`A conexão "${connectorId}" não está marcada como gravável.`)
  if (def.kind === 'postgres') {
    const res = await getPgPool(def).query(sql, params as never[])
    return { rowCount: res.rowCount ?? 0, rows: res.rows }
  }
  if (def.kind === 'mysql') {
    const [result] = await getMysqlPool(def).query(sql, params)
    const r = result as { affectedRows?: number; insertId?: number }
    return { rowCount: r.affectedRows ?? 0, rows: r.insertId != null ? [{ insertId: r.insertId }] : [] }
  }
  throw new Error(`Conexão "${connectorId}" (${def.kind}) não suporta escrita SQL.`)
}

// ESCRITA COM TETO (UPDATE/DELETE): roda a mutação numa TRANSAÇÃO e, se afetar
// mais linhas que `maxAffected`, faz ROLLBACK e falha — rede de segurança contra
// um filtro largo demais apagar/atualizar meio banco. maxAffected null = sem teto
// (o WHERE obrigatório já é garantido pelo construtor do SQL).
export async function execSourceGuarded(
  connectorId: string, sql: string, params: unknown[] = [], maxAffected: number | null = null,
): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  const def = getConnector(connectorId)
  if (!def) throw new Error(`Fonte desconhecida: ${connectorId}`)
  if (!def.writable) throw new Error(`A conexão "${connectorId}" não está marcada como gravável.`)
  const overLimit = (n: number) => maxAffected != null && n > maxAffected

  if (def.kind === 'postgres') {
    const client = await getPgPool(def).connect()
    try {
      await client.query('begin')
      const res = await client.query(sql, params as never[])
      const rowCount = res.rowCount ?? 0
      if (overLimit(rowCount)) {
        await client.query('rollback')
        throw new Error(`Bloqueado: a operação afetaria ${rowCount} linha(s), acima do teto de ${maxAffected}. Refine o filtro (where).`)
      }
      await client.query('commit')
      return { rowCount, rows: res.rows }
    } catch (e) {
      try { await client.query('rollback') } catch { /* já pode ter feito rollback */ }
      throw e
    } finally {
      client.release()
    }
  }
  if (def.kind === 'mysql') {
    const conn = await getMysqlPool(def).getConnection()
    try {
      await conn.beginTransaction()
      const [result] = await conn.query(sql, params)
      const rowCount = (result as { affectedRows?: number }).affectedRows ?? 0
      if (overLimit(rowCount)) {
        await conn.rollback()
        throw new Error(`Bloqueado: a operação afetaria ${rowCount} linha(s), acima do teto de ${maxAffected}. Refine o filtro (where).`)
      }
      await conn.commit()
      return { rowCount, rows: [] }
    } catch (e) {
      try { await conn.rollback() } catch { /* idem */ }
      throw e
    } finally {
      conn.release()
    }
  }
  throw new Error(`Conexão "${connectorId}" (${def.kind}) não suporta escrita SQL.`)
}

// Ping barato (SELECT 1) para a tela de conexões do admin.
export async function checkConnection(connectorId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const def = getConnector(connectorId)
  if (def?.kind === 'http') {
    const r = await testHttp(def.http?.baseUrl ?? '', {
      header: def.http?.authHeader, scheme: def.http?.authScheme, token: def.http?.token,
    })
    return { ok: r.ok, latencyMs: r.latencyMs, error: r.ok ? undefined : r.error }
  }
  const started = Date.now()
  try {
    await querySource(connectorId, 'select 1 as ok')
    return { ok: true, latencyMs: Date.now() - started }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: (e as Error).message }
  }
}

// Descoberta GENERALISTA de tabelas/views — só information_schema, sem nada
// específico de negócio. É a matéria-prima da publicação de datasets.
export async function discoverObjects(connectorId: string): Promise<
  { schema: string; name: string; kind: 'table' | 'view'; columns: number }[]
> {
  const def = getConnector(connectorId)
  if (!def) throw new Error(`Fonte desconhecida: ${connectorId}`)
  const sql = def.kind === 'mysql'
    ? `select table_schema as schema_name, table_name, table_type,
              (select count(*) from information_schema.columns c
                where c.table_schema = t.table_schema and c.table_name = t.table_name) as column_count
         from information_schema.tables t
        where table_schema = database()
        order by table_name`
    : `select table_schema as schema_name, table_name, table_type,
              (select count(*) from information_schema.columns c
                where c.table_schema = t.table_schema and c.table_name = t.table_name) as column_count
         from information_schema.tables t
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name`
  const { rows } = await querySource(connectorId, sql)
  return rows.map((r) => ({
    schema: String(r.schema_name),
    name: String(r.table_name),
    kind: String(r.table_type).toLowerCase().includes('view') ? 'view' : 'table',
    columns: Number(r.column_count) || 0,
  }))
}

// Colunas de um objeto físico — insumo para o admin publicar um dataset.
export async function discoverColumns(connectorId: string, schema: string, table: string): Promise<
  { name: string; dataType: string; nullable: boolean }[]
> {
  const sql = `select column_name, data_type, is_nullable
                 from information_schema.columns
                where table_schema = $1 and table_name = $2
                order by ordinal_position`
  const def = getConnector(connectorId)
  if (!def) throw new Error(`Fonte desconhecida: ${connectorId}`)
  const { rows } = def.kind === 'mysql'
    ? await querySource(connectorId, sql.replace('$1', '?').replace('$2', '?'), [schema, table])
    : await querySource(connectorId, sql, [schema, table])
  return rows.map((r) => ({
    name: String(r.column_name),
    dataType: String(r.data_type),
    nullable: String(r.is_nullable).toLowerCase() === 'yes',
  }))
}

export { CONNECTORS, isConfigured }
