// ─────────────────────────────────────────────────────────────────────────
// Cliente MariaDB com a CARA do pg.Pool: query(sql, params) → { rows,
// rowCount }, connect() → cliente com query/release, end(). O resto da API
// não sabe em que banco está — é o que permite trocar com uma variável
// (DATAHUB_DB_DRIVER) e voltar com outra.
//
// O SQL chega em dialeto Postgres e passa pelo tradutor (translate.ts). As
// linhas voltam no formato que o driver do Postgres entregaria:
//   bigint de coluna → texto · boolean → true/false · json → objeto
//   timestamptz → Date · date → Date à meia-noite local · text[] → array
// e os parâmetros são escapados AQUI, um a um, na posição exata do
// marcador (o format() do mysql2 trocaria "?" dentro de literais).
// ─────────────────────────────────────────────────────────────────────────
import mysql from 'mysql2/promise'
import type { FieldPacket, Pool as MyPool, PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { translate, splitStatements, type Seg, type Translated, type Hint, type ParamKind } from './translate.js'

// O mysql2 só conhece as colações do MySQL (ids até ~316). As colunas do hub
// usam utf8mb4_nopad_bin, que no MariaDB tem id 1070: sem isto, o driver não
// sabe decodificar o texto e a consulta falha ("Encoding not recognized").
// O mapa é o MESMO objeto que o driver consulta (mesmo módulo CommonJS).
// (caminho absoluto: o "exports" do pacote não expõe lib/)
{
  const req = createRequire(import.meta.url)
  const enc = req(resolve(dirname(req.resolve('mysql2')), 'lib/constants/charset_encodings.js')) as string[]
  enc[1070] = 'utf8' // utf8mb4_nopad_bin
}

export interface MariaCfg { host: string; port: number; database: string; user: string; password: string }
export interface Result { rows: Record<string, any>[]; rowCount: number }
export interface Client { query: (sql: string, params?: unknown[]) => Promise<Result>; release: (err?: unknown) => void }

// Sessão igual em toda conexão. PIPES_AS_CONCAT: "||" concatena, como no
// Postgres. ANSI_QUOTES: "x" é identificador. READ-COMMITTED: o isolamento
// padrão do Postgres. UTC: as datas são gravadas e lidas em UTC.
// group_concat_max_len: o padrão (1 KB) cortaria o string_agg em silêncio.
const SESSION = [
  "SET SESSION sql_mode = 'PIPES_AS_CONCAT,ANSI_QUOTES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION time_zone = '+00:00'",
  'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED', // (a variável muda de nome na 11.1)
  'SET NAMES utf8mb4 COLLATE utf8mb4_nopad_bin',
  'SET SESSION group_concat_max_len = 16777216',
]
async function setupSession(c: PoolConnection): Promise<void> {
  for (const s of SESSION) await c.query(s)
}

// ── O que o banco sabe do próprio esquema ────────────────────────────────
interface Registry { json: Set<string>; pk: Map<string, string[]>; notNull: Set<string>; datetime: Set<string> }
let registry: Registry = { json: new Set(), pk: new Map(), notNull: new Set(), datetime: new Set() }
const cache = new Map<string, Translated>()

function tr(sql: string): Translated {
  let t = cache.get(sql)
  if (!t) {
    t = translate(sql, {
      pk: (x) => registry.pk.get(x),
      notNull: (c) => registry.notNull.has(c),
      datetimeCol: (c) => registry.datetime.has(c),
    })
    if (cache.size > 5000) cache.clear()
    cache.set(sql, t)
  }
  return t
}

async function loadRegistry(conn: PoolConnection): Promise<void> {
  const [cols] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE AS n, DATA_TYPE AS ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`)
  const [checks] = await conn.query(
    `SELECT TABLE_NAME AS t, CHECK_CLAUSE AS cl FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`)
  const [keys] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`)
  const json = new Set<string>()
  for (const r of checks as Array<{ t: string; cl: string }>) {
    // com ANSI_QUOTES o MariaDB devolve "col"; sem, `col`
    const m = /^json_valid\([`"]([^`"]+)[`"]\)$/i.exec(String(r.cl).trim())
    if (m) json.add(`${r.t}.${m[1]}`)
  }
  const pk = new Map<string, string[]>()
  for (const r of keys as Array<{ t: string; c: string }>) pk.set(r.t, [...(pk.get(r.t) ?? []), r.c])
  const nullable = new Set<string>()
  const all = new Set<string>()
  const notDt = new Set<string>()
  for (const r of cols as Array<{ c: string; n: string; ty: string }>) {
    all.add(r.c)
    if (r.n === 'YES') nullable.add(r.c)
    if (String(r.ty).toLowerCase() !== 'datetime') notDt.add(r.c)
  }
  registry = {
    json, pk,
    notNull: new Set([...all].filter((c) => !nullable.has(c))),
    datetime: new Set([...all].filter((c) => !notDt.has(c))),
  }
  cache.clear()
}

// ── Parâmetros ───────────────────────────────────────────────────────────
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const utc = (d: Date) => `'${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}'`
// '2026-11-12T14:02:35.503Z', '2026-11-12T11:02:35-03:00' — texto que o
// Postgres lê como instante e o MariaDB recusa na coluna DATETIME.
const ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/
const localDay = (d: Date) => `'${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}'`

function lit(v: unknown, kind: ParamKind): string {
  if (v === undefined || v === null) return 'NULL'
  switch (kind) {
    case 'int': {
      const n = typeof v === 'bigint' ? v : Number(v)
      if (typeof n === 'number' && !Number.isFinite(n)) throw new Error(`parâmetro numérico inválido: ${String(v)}`)
      return typeof n === 'bigint' ? n.toString() : String(Math.trunc(n))
    }
    case 'datetime': {
      const d = v instanceof Date ? v : new Date(String(v))
      if (Number.isNaN(d.getTime())) throw new Error(`data/hora inválida: ${String(v)}`)
      return utc(d)
    }
    case 'date':
      return v instanceof Date ? localDay(v) : mysql.escape(String(v))
    case 'json':
      return mysql.escape(typeof v === 'string' ? v : JSON.stringify(v))
    case 'dtsoft':
      return typeof v === 'string' && ISO_COM_FUSO.test(v) ? utc(new Date(v)) : lit(v, 'value')
    default:
      if (v instanceof Date) return utc(v)
      if (Buffer.isBuffer(v)) return mysql.escape(v)
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
      if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`parâmetro numérico inválido: ${v}`); return String(v) }
      if (typeof v === 'bigint') return v.toString()
      // array (text[] no Postgres) e objeto (jsonb): JSON no MariaDB
      if (typeof v === 'object') return mysql.escape(JSON.stringify(v))
      return mysql.escape(String(v))
  }
}

// lista vazia: "x IN ()" não existe; uma subconsulta vazia dá o mesmo
// resultado do Postgres — = any('{}') é falso e <> all('{}') é verdadeiro.
const EMPTY_SET = '(SELECT NULL FROM DUAL WHERE 1=0)'

function render(segs: Seg[], params: unknown[], ids?: string): string {
  let out = ''
  for (const s of segs) {
    if (typeof s === 'string') { out += s; continue }
    if ('ids' in s) { out += ids ?? EMPTY_SET; continue }
    if (s.p >= params.length) throw new Error(`parâmetro $${s.p + 1} ausente`)
    const v = params[s.p]
    if (s.kind === 'list') {
      const arr = Array.isArray(v) ? v : v == null ? [] : [v]
      out += arr.length ? `(${arr.map((x) => lit(x, 'value')).join(', ')})` : EMPTY_SET
    } else out += lit(v, s.kind)
  }
  return out
}

// ── Linhas: o formato do driver do Postgres ──────────────────────────────
// Tipos do protocolo (mysql2/lib/constants/types)
const T = { TINY: 1, TIMESTAMP: 7, LONGLONG: 8, DATE: 10, DATETIME: 12, NEWDATE: 14 }
type Conv = ((v: unknown) => unknown) | null

function converter(f: FieldPacket): Conv {
  const col = f as FieldPacket & { columnType: number; columnLength: number; orgTable: string; orgName: string }
  switch (col.columnType) {
    case T.TINY:
      return col.columnLength === 1 ? (v) => (v === null ? null : Number(v) !== 0) : null
    case T.DATE: case T.NEWDATE:
      return (v) => { if (v === null) return null; const [y, m, d] = String(v).split('-').map(Number); return new Date(y, m - 1, d) }
    case T.DATETIME: case T.TIMESTAMP:
      return (v) => (v === null ? null : new Date(`${String(v).replace(' ', 'T')}Z`))
    case T.LONGLONG:
      // coluna bigint: o pg devolve texto. Expressão (soma, contagem já
      // tratada pelo hint): número, como o int do Postgres.
      if (col.orgTable) return null
      return (v) => { if (v === null) return null; const n = Number(v); return Number.isSafeInteger(n) ? n : v }
  }
  if (col.orgTable && registry.json.has(`${col.orgTable}.${col.orgName}`)) {
    return (v) => (v === null ? null : JSON.parse(Buffer.isBuffer(v) ? v.toString('utf8') : String(v)))
  }
  return null
}

function applyHint(v: unknown, h: Hint): unknown {
  if (v === null || v === undefined) return v
  switch (h) {
    case 'int': return Number(v)
    case 'text': return String(v)
    case 'bool': return typeof v === 'boolean' ? v : Number(v) !== 0
    case 'json': return typeof v === 'string' ? JSON.parse(v) : Buffer.isBuffer(v) ? JSON.parse(v.toString('utf8')) : v
  }
}

function shape(res: unknown, fields: FieldPacket[] | undefined, hints: Record<string, Hint>): Result {
  if (!Array.isArray(res)) return { rows: [], rowCount: (res as ResultSetHeader).affectedRows ?? 0 }
  const rows = res as Record<string, unknown>[]
  const convs = (fields ?? []).map((f) => [f.name, converter(f)] as const).filter(([, c]) => c) as Array<[string, (v: unknown) => unknown]>
  const hs = Object.entries(hints)
  for (const r of rows) {
    for (const [name, c] of convs) if (name in r) r[name] = c(r[name])
    for (const [name, h] of hs) if (name in r) r[name] = applyHint(r[name], h)
  }
  return { rows, rowCount: rows.length }
}

// ── Erros: o código SQLSTATE que o resto do código já trata ─────────────
const SQLSTATE: Record<number, string> = {
  1062: '23505', 1451: '23503', 1452: '23503', 1048: '23502', 4025: '23514', 3819: '23514',
  1406: '22001', 1264: '22003', 1690: '22003', 1365: '22012', 1292: '22007', 1366: '22P02',
  1411: '22007', 1213: '40P01', 1205: '55P03',
}
function mapError(e: unknown): unknown {
  if (e && typeof e === 'object' && 'errno' in e) {
    const err = e as { errno: number; code?: string; mysqlCode?: string }
    const code = SQLSTATE[err.errno]
    if (code) { err.mysqlCode = err.code; err.code = code }
  }
  return e
}

// ── Execução ─────────────────────────────────────────────────────────────
interface State { inTx: boolean }

async function exec(conn: PoolConnection, sql: string, params: unknown[] = [], st: State): Promise<Result> {
  const t = tr(sql)
  if (t.kind === 'tx') {
    const cmd = t.segs[0] as string
    await conn.query(cmd)
    st.inTx = cmd === 'BEGIN'
    return { rows: [], rowCount: 0 }
  }
  if (t.kind === 'update-returning') return updateReturning(conn, t, params, st)
  const text = render(t.segs, params)
  try {
    const [res, fields] = await conn.query(text)
    return shape(res, fields as FieldPacket[], t.hints)
  } catch (e) {
    // on conflict do nothing: a duplicata não é erro, é "0 linhas". No MariaDB
    // o erro desfaz só o comando, não a transação em volta.
    if (t.kind === 'insert-do-nothing' && (e as { errno?: number }).errno === 1062) return { rows: [], rowCount: 0 }
    throw mapError(e)
  }
}

/**
 * UPDATE … RETURNING, que o MariaDB não tem: trava as linhas que o WHERE
 * pega, atualiza por chave e relê — tudo numa transação (a do chamador, se
 * houver). O resultado é o do Postgres: as linhas JÁ atualizadas.
 */
async function updateReturning(conn: PoolConnection, t: Translated, params: unknown[], st: State): Promise<Result> {
  const plan = t.upd!
  const own = !st.inTx
  if (own) await conn.query('BEGIN')
  try {
    const [locked] = await conn.query({ sql: render(plan.lock, params), typeCast: (f: { string: () => string | null }) => f.string() } as never)
    const keys = (locked as Record<string, string>[]).map((r) => plan.pk.map((c) => r[c]))
    if (!keys.length) { if (own) await conn.query('COMMIT'); return { rows: [], rowCount: 0 } }
    const ids = `(${keys.map((k) => (k.length === 1 ? mysql.escape(k[0]) : `(${k.map((x) => mysql.escape(x)).join(', ')})`)).join(', ')})`
    await conn.query(render(plan.update, params, ids))
    const [res, fields] = await conn.query(render(plan.select, params, ids))
    if (own) await conn.query('COMMIT')
    const out = shape(res, fields as FieldPacket[], t.hints)
    return { rows: out.rows, rowCount: keys.length }
  } catch (e) {
    if (own) await conn.query('ROLLBACK').catch(() => {})
    throw mapError(e)
  }
}

export class MariaPool {
  readonly raw: MyPool
  private ready = new WeakSet<object>()

  constructor(cfg: MariaCfg, opts: { max?: number } = {}) {
    this.raw = mysql.createPool({
      host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password,
      connectionLimit: opts.max ?? 10,
      connectTimeout: 5_000,
      charset: 'UTF8MB4_GENERAL_CI',
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false, // um comando por chamada: SQL empilhado não passa nem por engano
    })
  }

  private async conn(): Promise<PoolConnection> {
    const c = await this.raw.getConnection()
    const core = (c as unknown as { connection: object }).connection
    if (!this.ready.has(core)) {
      await setupSession(c)
      this.ready.add(core)
    }
    return c
  }

  async query(sql: string, params?: unknown[]): Promise<Result> {
    const c = await this.conn()
    try { return await exec(c, sql, params, { inTx: false }) } finally { c.release() }
  }

  async connect(): Promise<Client> {
    const c = await this.conn()
    const st: State = { inTx: false }
    let released = false
    return {
      query: (sql, params) => exec(c, sql, params, st),
      release: () => {
        if (released) return
        released = true
        // transação esquecida aberta não pode vazar para o próximo que pegar a conexão
        if (st.inTx) c.query('ROLLBACK').catch(() => {}).finally(() => c.release())
        else c.release()
      },
    }
  }

  async end(): Promise<void> { await this.raw.end() }

  /** Recarrega o que o banco sabe do esquema (depois de migration). */
  async refreshRegistry(): Promise<void> {
    const c = await this.conn()
    try { await loadRegistry(c) } finally { c.release() }
  }
}

/**
 * Migrations no MariaDB. Os nomes são os MESMOS das do Postgres: toda
 * migration nova precisa existir nas duas pastas, senão a API não sobe no
 * MariaDB (o esquema ficaria diferente sem ninguém perceber).
 * O MariaDB não desfaz DDL em transação: cada arquivo deve ser idempotente
 * (IF NOT EXISTS), para que uma falha no meio possa ser retomada.
 */
export async function runMariaMigrations(pool: MariaPool, pgDir: string, mariaDir: string, opts: { skipSeed?: boolean; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const c = await pool.raw.getConnection()
  try {
    await setupSession(c)
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin`)
    const applied = async () => new Set(((await c.query('SELECT name FROM schema_migrations'))[0] as Array<{ name: string }>).map((r) => r.name))
    const pgFiles = (await readdir(pgDir)).filter((f) => f.endsWith('.sql'))
    const mariaFiles = (await readdir(mariaDir)).filter((f) => f.endsWith('.sql'))
    const maria = new Set(mariaFiles)
    const names = [...new Set([...pgFiles, ...mariaFiles])].sort()
    let done = await applied()
    for (const name of names) {
      if (done.has(name)) continue
      if (!maria.has(name)) {
        throw new Error(`a migration ${name} não tem versão MariaDB (crie src/db/migrations-mariadb/${name}); o banco ficaria diferente do Postgres`)
      }
      if (name === '000-seed.sql' && opts.skipSeed) {
        await c.query('INSERT INTO schema_migrations (name) VALUES (?)', [name])
        done = await applied()
        continue
      }
      const text = await readFile(resolve(mariaDir, name), 'utf8')
      for (const stmt of splitStatements(text)) {
        try { await c.query(stmt) } catch (e) {
          throw new Error(`migration ${name} falhou em: ${stmt.replace(/\s+/g, ' ').slice(0, 160)} — ${(e as Error).message}`)
        }
      }
      await c.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [name])
      log(`[db] migration aplicada (mariadb): ${name}`)
      done = await applied()
    }
  } finally {
    c.release()
  }
  await pool.refreshRegistry()
}
