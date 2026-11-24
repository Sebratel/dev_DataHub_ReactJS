// Banco de METADADOS do hub (catálogo, usuários, permissões, auditoria).
// Migrations SQL simples, versionadas em src/db/migrations e aplicadas no boot.
// Se o banco estiver fora, a API sobe em modo degradado (health/conexões ainda
// funcionam) e loga o aviso — útil em dev antes do `docker compose up datahub-db`.
//
// DATAHUB_DB_DRIVER=mariadb troca o banco (D-DSP-4): o mesmo SQL passa pelo
// tradutor em db/mariadb/ e as migrations vêm de src/db/migrations-mariadb
// (mesmos nomes). O padrão continua sendo o Postgres.
import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config, mariaFaltando } from '../core/config.js'
import { MariaPool, runMariaMigrations } from './mariadb/client.js'
import { MIGRATIONS_DIR, MARIA_MIGRATIONS_DIR } from './paths.js'

const { Pool } = pg

export const dbDriver = config.datahubDbDriver

// O tipo exposto é o do pg.Pool (query/connect/end): o cliente MariaDB tem a
// mesma forma, e assim nenhum dos ~60 arquivos que consultam o banco muda.
const maria = dbDriver === 'mariadb' ? new MariaPool(config.datahubMaria) : null
export const db: pg.Pool = maria
  ? (maria as unknown as pg.Pool)
  : new Pool({
    ...config.datahubPg,
    max: 10,
    connectionTimeoutMillis: 5_000,
  })

let dbAvailable = false
export function isDbAvailable(): boolean {
  return dbAvailable
}

// Retenta por ~30 s: cobre o caso comum de a API subir junto com o container
// do Postgres (docker compose) antes de ele aceitar conexões.
export async function runMigrations(attempts = 10, delayMs = 3_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    await tryMigrations()
    if (dbAvailable || i === attempts) return
    console.warn(`[db] nova tentativa em ${delayMs / 1000}s (${i}/${attempts})…`)
    await new Promise((r) => setTimeout(r, delayMs))
  }
}

// ── Banco vivo de verdade (D-12 do comitê) ────────────────────────────────
// `dbAvailable` era decidido UMA vez, no boot: se o banco caísse depois, o
// /api/health seguia dizendo "ok" e tudo respondia erro sem ninguém saber; se
// estivesse fora no boot, a API ficava degradada para sempre. Agora um "select 1"
// confere o banco (com cache curto, para o health não martelar), e um vigia
// religa sozinho quando ele volta.
const PING_TIMEOUT_MS = 3_000
let ultimoPing = { ok: false, em: 0 }
let pinger: () => Promise<unknown> = () => db.query('select 1')

/** O banco responde agora? Reaproveita a resposta de até `maxAgeMs` atrás. */
export async function pingDb(maxAgeMs = 5_000): Promise<boolean> {
  if (ultimoPing.em && Date.now() - ultimoPing.em < maxAgeMs) return ultimoPing.ok
  let timer: NodeJS.Timeout | undefined
  let ok = false
  try {
    await Promise.race([
      pinger(),
      new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('timeout')), PING_TIMEOUT_MS) }),
    ])
    ok = true
  } catch { ok = false } finally { if (timer) clearTimeout(timer) }
  ultimoPing = { ok, em: Date.now() }
  return ok
}

/** Banco disponível, conferido ao vivo (o que o /api/health responde). */
export async function dbHealthy(): Promise<boolean> {
  return dbAvailable && await pingDb()
}

/**
 * Vigia do banco: a cada `intervalMs`, se ele nunca subiu, tenta as migrations
 * de novo (e chama `onRecovered` para completar o boot); se já tinha subido,
 * confere se segue vivo e liga/desliga `dbAvailable` — com o banco fora, as
 * rotas que dependem dele respondem 503 em vez de erro solto. Devolve a função
 * que para o vigia.
 */
export function startDbWatch(opts: { intervalMs?: number; onRecovered?: () => Promise<void> } = {}): () => void {
  let migrado = dbAvailable
  let ocupado = false
  const tick = async () => {
    if (ocupado) return
    ocupado = true
    try {
      if (!migrado) {
        await tryMigrations(true)
        if (dbAvailable) {
          migrado = true
          console.log('[db] banco de metadados disponível — completando o boot.')
          await opts.onRecovered?.().catch((e) => console.warn(`[db] boot tardio falhou: ${(e as Error).message}`))
        }
        return
      }
      const ok = await pingDb(0)
      if (ok !== dbAvailable) {
        dbAvailable = ok
        if (ok) console.log('[db] banco de metadados voltou.')
        else console.warn('[db] banco de metadados FORA DO AR — rotas que dependem dele respondem 503 até ele voltar.')
      }
    } finally {
      ocupado = false
    }
  }
  const t = setInterval(() => { void tick() }, opts.intervalMs ?? 15_000)
  t.unref()
  return () => clearInterval(t)
}

/** Só para teste: troca o "select 1" e esquece o último ping. */
export function __setDbPingForTest(fn: (() => Promise<unknown>) | null): void {
  pinger = fn ?? (() => db.query('select 1'))
  ultimoPing = { ok: false, em: 0 }
}

async function tryMigrations(silencioso = false): Promise<void> {
  try {
    if (maria) {
      const faltando = mariaFaltando()
      if (faltando.length) throw new Error(`DATAHUB_DB_DRIVER=mariadb, mas falta na stack: ${faltando.join(', ')}`)
      await runMariaMigrations(maria, MIGRATIONS_DIR, MARIA_MIGRATIONS_DIR)
      dbAvailable = true
      console.log(`[db] banco datahub pronto (mariadb ${config.datahubMaria.host}/${config.datahubMaria.database}).`)
      return
    }
    await db.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now()
    )`)
    const applied = new Set(
      (await db.query('select name from schema_migrations')).rows.map((r) => r.name as string),
    )
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8')
      const client = await db.connect()
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        console.log(`[db] migration aplicada: ${file}`)
      } catch (e) {
        await client.query('rollback')
        throw e
      } finally {
        client.release()
      }
    }
    dbAvailable = true
    console.log('[db] banco datahub pronto.')
  } catch (e) {
    dbAvailable = false
    if (silencioso) return // o vigia tenta a cada 15 s: um aviso por tentativa encheria o log
    console.warn(`[db] banco datahub indisponível. (${(e as Error).message})`)
    console.warn(maria
      ? `[db] confira DATAHUB_MARIA_* (host ${config.datahubMaria.host}:${config.datahubMaria.port}, banco ${config.datahubMaria.database}).`
      : '[db] se não estiver rodando, suba com: docker compose up -d datahub-db')
  }
}
