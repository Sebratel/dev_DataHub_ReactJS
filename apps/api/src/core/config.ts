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

  auth: {
    // Projeto Firebase que emite os ID tokens. Definido = a API passa a aceitar
    // login por Firebase (assinatura conferida localmente, sem chamar o Google
    // a cada request). Vazio = só o caminho antigo, com access_token do Google.
    // Os dois convivem: a migração pode ser feita sem janela de indisponibilidade.
    firebaseProjectId: (process.env.FIREBASE_PROJECT_ID || '').trim(),
  },

  // Banco de METADADOS do hub (catálogo, usuários, dashboards…).
  datahubDb: {
    host: process.env.DATAHUB_DB_HOST || 'localhost',
    port: Number(process.env.DATAHUB_DB_PORT) || 5433,
    database: process.env.DATAHUB_DB_DATABASE || 'datahub',
    user: process.env.DATAHUB_DB_USER || 'datahub',
    password: process.env.DATAHUB_DB_PASSWORD || 'datahub-dev',
  },

  // Fontes de dados: teto de execução por consulta na ORIGEM (Postgres e MySQL/
  // MariaDB). Protege os bancos de produção de uma consulta lenta pendurar.
  sources: {
    statementTimeoutMs: Number(process.env.SOURCE_STATEMENT_TIMEOUT_MS) || 120_000,
  },

  // Ingestão — controles de carga (docs §9.1).
  sync: {
    hour: Math.min(23, Math.max(0, Number(process.env.ETL_HOUR ?? 3))),
    batchSize: Number(process.env.SYNC_BATCH_SIZE) || 50_000,
    batchPauseMs: Number(process.env.SYNC_BATCH_PAUSE_MS) || 500,
    // Disjuntor anti-fuga: aborta a carga se passar deste nº de linhas. 0 = sem
    // limite. Protege o servidor de uma sincronização descontrolada (ex.: OFFSET
    // relendo linhas). Defina no .env/stack conforme a maior tabela + folga.
    maxRows: Number(process.env.SYNC_MAX_ROWS) || 0,
  },

  // Motor de consulta (DuckDB). Limites protegem o servidor de uma consulta
  // pesada de um time derrubar o hub para todos.
  duck: {
    memoryLimit: process.env.DUCK_MEMORY_LIMIT || '2GB',
    threads: Math.max(1, Number(process.env.DUCK_THREADS) || 4),
    // Timeout só nas consultas INTERATIVAS (explorador, preview, IA). A
    // materialização/ingestão em background não usa timeout.
    queryTimeoutMs: Number(process.env.DUCK_QUERY_TIMEOUT_MS) || 30_000,
    // Máx. de consultas SIMULTÂNEAS no motor; o excedente espera em fila. Evita
    // que um dashboard com muitos widgets (ou vários usuários) dê pico de carga.
    maxConcurrency: Math.max(1, Number(process.env.DUCK_MAX_CONCURRENCY) || 6),
    // Pista separada para carga AD-HOC (notebook, prévia de derivado, base de
    // atributos de modelo). Menor de propósito: uma consulta exploratória
    // grande não pode ocupar os slots dos painéis.
    maxAdhocConcurrency: Math.max(1, Number(process.env.DUCK_MAX_ADHOC_CONCURRENCY) || 2),
    // Exports rodam um por vez. Cada um pode varrer a tabela inteira por
    // minutos; em paralelo eles competiriam por memória e I/O e degradariam
    // o hub para todo mundo. O segundo espera na fila — e termina.
    maxExportConcurrency: Math.max(1, Number(process.env.DUCK_MAX_EXPORT_CONCURRENCY) || 1),
  },
}

export function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length) throw new Error(`Variáveis ausentes no .env: ${missing.join(', ')}`)
}
