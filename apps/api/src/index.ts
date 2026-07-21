// ─────────────────────────────────────────────────────────────────────────
// Data Hub API — entrada do backend. Módulos montados aqui; cada módulo é um
// Router independente (docs §6). Sprint 1: health, auth/me, admin/connections.
// ─────────────────────────────────────────────────────────────────────────
import express from 'express'
import { config } from './core/config.js'
import { runMigrations, isDbAvailable } from './db/pool.js'
import { requireAuth } from './modules/auth/middleware.js'
import { connectionsRouter } from './modules/catalog/connectionsRouter.js'
import { datasetsRouter } from './modules/catalog/datasetsRouter.js'
import { syncRouter } from './modules/sync/syncRouter.js'
import { queryRouter } from './modules/query/queryRouter.js'
import { viewsRouter } from './modules/explorer/viewsRouter.js'
import { exportRouter } from './modules/explorer/exportRouter.js'
import { transformRouter } from './modules/transform/transformRouter.js'
import { metricsRouter } from './modules/metrics/metricsRouter.js'
import { dashboardsRouter } from './modules/dashboards/dashboardsRouter.js'
import { aiRouter } from './modules/ai/aiRouter.js'
import { credentialsRouter, publicRouter } from './modules/integrations/integrationsRouter.js'
import { accessRouter } from './modules/admin/accessRouter.js'
import { startScheduler } from './modules/sync/scheduler.js'
import { reindexEmbeddings } from './modules/ai/embeddings.js'

// Rede de segurança: Express 4 não encaminha rejeições de handlers async ao
// middleware de erro — sem isto, um único erro de SQL derruba a API inteira
// (foi o que aconteceu com o 42702 do POST /metrics). Logamos e seguimos vivos.
process.on('unhandledRejection', (err) => {
  console.error('[api] rejeição não tratada (rota async?):', err)
})
process.on('uncaughtException', (err) => {
  console.error('[api] exceção não capturada:', err)
})

const app = express()
app.use(express.json({ limit: '4mb' }))

// CORS — necessário em dev (Vite em outra porta); em produção o nginx faz
// proxy same-origin de /api/. Reflete a origem; sem cookies.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'datahub-api', metadataDb: isDbAvailable() ? 'ok' : 'offline' })
})

// Sessão do usuário logado (provisiona no primeiro acesso).
app.get('/api/v1/auth/me', requireAuth(), (req, res) => {
  res.json({ user: req.user })
})

// Admin: fontes de dados e controle de acesso (usuários, times, concessões).
app.use('/api/v1/connections', connectionsRouter)
app.use('/api/v1/admin', accessRouter)

// Catálogo de conjuntos de dados. ORDEM IMPORTA: query e sync têm rotas mais
// específicas (/:slug/query, /:id/sync) e vêm antes do router genérico.
app.use('/api/v1/datasets', queryRouter)
app.use('/api/v1/datasets', syncRouter)
app.use('/api/v1/datasets', viewsRouter)
app.use('/api/v1/datasets', exportRouter)
app.use('/api/v1/datasets', transformRouter) // /derived — antes do genérico
app.use('/api/v1/datasets', datasetsRouter)

// Biblioteca de métricas e dashboards.
app.use('/api/v1/metrics', metricsRouter)
app.use('/api/v1/dashboards', dashboardsRouter)

// Chat IA e integrações.
app.use('/api/v1/ai', aiRouter)
app.use('/api/v1/credentials', credentialsRouter)
app.use('/api/public/v1', publicRouter)

app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }))

await runMigrations()
startScheduler() // sync diário na madrugada (ETL_HOUR)
// Catálogo semântico: indexa em background os datasets sem embedding (ou com
// texto desatualizado). Não bloqueia o boot — na 1ª vez baixa o modelo (~120MB).
if (isDbAvailable()) {
  void reindexEmbeddings().catch((e) =>
    console.warn(`[embeddings] indexação inicial falhou: ${(e as Error).message}`))
}
app.listen(config.apiPort, () => {
  console.log(`[api] Data Hub API em http://localhost:${config.apiPort}`)
})
