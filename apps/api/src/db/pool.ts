// Banco de METADADOS do hub (catálogo, usuários, permissões, auditoria).
// Migrations SQL simples, versionadas em src/db/migrations e aplicadas no boot.
// Se o banco estiver fora, a API sobe em modo degradado (health/conexões ainda
// funcionam) e loga o aviso — útil em dev antes do `docker compose up datahub-db`.
import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../core/config.js'

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')

export const db = new Pool({
  ...config.datahubDb,
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

async function tryMigrations(): Promise<void> {
  try {
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
    console.warn(`[db] banco datahub indisponível. (${(e as Error).message})`)
    console.warn('[db] se não estiver rodando, suba com: docker compose up -d datahub-db')
  }
}
