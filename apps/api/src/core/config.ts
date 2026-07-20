// Configuração central — única porta de entrada para o process.env.
// O .env fica na RAIZ do monorepo (mesmo formato do churn_mvp).
import { config as loadEnv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '../../../../.env') })
loadEnv() // fallback: .env local do app, se existir

export const config = {
  apiPort: Number(process.env.API_PORT) || 8790,
  allowedDomain: (process.env.ALLOWED_DOMAIN || 'sebratel.com.br').toLowerCase(),
  // CSV de e-mails com papel admin garantido no primeiro login.
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Banco de METADADOS do hub (catálogo, usuários, dashboards…).
  datahubDb: {
    host: process.env.DATAHUB_DB_HOST || 'localhost',
    port: Number(process.env.DATAHUB_DB_PORT) || 5433,
    database: process.env.DATAHUB_DB_DATABASE || 'datahub',
    user: process.env.DATAHUB_DB_USER || 'datahub',
    password: process.env.DATAHUB_DB_PASSWORD || 'datahub-dev',
  },

  // Ingestão — controles de carga (docs §9.1).
  sync: {
    hour: Math.min(23, Math.max(0, Number(process.env.ETL_HOUR ?? 3))),
    batchSize: Number(process.env.SYNC_BATCH_SIZE) || 50_000,
    batchPauseMs: Number(process.env.SYNC_BATCH_PAUSE_MS) || 500,
  },

  // Motor de consulta (DuckDB). Limites protegem o servidor de uma consulta
  // pesada de um time derrubar o hub para todos.
  duck: {
    memoryLimit: process.env.DUCK_MEMORY_LIMIT || '2GB',
    threads: Math.max(1, Number(process.env.DUCK_THREADS) || 4),
    // Timeout só nas consultas INTERATIVAS (explorador, preview, IA). A
    // materialização/ingestão em background não usa timeout.
    queryTimeoutMs: Number(process.env.DUCK_QUERY_TIMEOUT_MS) || 30_000,
  },
}

export function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length) throw new Error(`Variáveis ausentes no .env: ${missing.join(', ')}`)
}
