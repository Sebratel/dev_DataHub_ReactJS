// ─────────────────────────────────────────────────────────────────────────
// Montagem da API: middlewares e rotas, SEM efeitos colaterais. Quem sobe o
// servidor de verdade (migrations, agendador, embeddings, listen) é o
// index.ts; os testes de integração (src/test/) montam este mesmo app contra
// um banco de teste — é a API real, rota por rota, sem os trabalhos de fundo.
// ─────────────────────────────────────────────────────────────────────────
import express from 'express'
import { isDbAvailable } from './db/pool.js'
import { requireAuth } from './modules/auth/middleware.js'
import { connectionsRouter } from './modules/catalog/connectionsRouter.js'
import { datasetsRouter } from './modules/catalog/datasetsRouter.js'
import { syncRouter } from './modules/sync/syncRouter.js'
import { schedulesRouter } from './modules/sync/schedulesRouter.js'
import { autotuneRouter } from './modules/sync/autotuneRouter.js'
import { queryRouter } from './modules/query/queryRouter.js'
import { viewsRouter } from './modules/explorer/viewsRouter.js'
import { exportRouter } from './modules/explorer/exportRouter.js'
import { transformRouter } from './modules/transform/transformRouter.js'
import { databricksRouter, databricksAdminRouter } from './modules/databricks/databricksRouter.js'
import { metricsRouter } from './modules/metrics/metricsRouter.js'
import { dashboardsRouter } from './modules/dashboards/dashboardsRouter.js'
import { aiWidgetsRouter } from './modules/dashboards/aiWidgetsRouter.js'
import { aiRouter } from './modules/ai/aiRouter.js'
import { aiProvidersRouter } from './modules/ai/aiProvidersRouter.js'
import { credentialsRouter, publicRouter } from './modules/integrations/integrationsRouter.js'
import { productsRouter } from './modules/integrations/productsRouter.js'
import { gatewayRouter } from './modules/gateway/gatewayRouter.js'
import { gatewayProxyRouter } from './modules/gateway/proxy.js'
import { mlRouter } from './modules/ml/mlRouter.js'
import { notebooksRouter } from './modules/notebooks/notebooksRouter.js'
import { accessRouter } from './modules/admin/accessRouter.js'
import { monitorRouter } from './modules/admin/monitorRouter.js'
import { diskRouter } from './modules/admin/diskRouter.js'

export function createApp(): express.Express {
  const app = express()

  // ORDEM IMPORTA: o proxy do gateway precisa do corpo CRU para repassar ao
  // upstream sem interpretar. Se o express.json() rodasse antes, ele consumiria o
  // stream e o proxy encaminharia corpo vazio. Por isso o gateway vem primeiro e
  // aplica o próprio express.raw() internamente.
  app.use('/api/public/v1/gw', gatewayProxyRouter)

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
  app.use('/api/v1/health-checks', monitorRouter)
  app.use('/api/v1/disk', diskRouter)

  // Catálogo de conjuntos de dados. ORDEM IMPORTA: query e sync têm rotas mais
  // específicas (/:slug/query, /:id/sync) e vêm antes do router genérico.
  app.use('/api/v1/datasets', queryRouter)
  app.use('/api/v1/datasets', autotuneRouter) // /auto-incremental — antes do genérico
  app.use('/api/v1/datasets', syncRouter)
  app.use('/api/v1/schedules', schedulesRouter)
  app.use('/api/v1/datasets', viewsRouter)
  app.use('/api/v1/datasets', exportRouter)
  app.use('/api/v1/datasets', transformRouter) // /derived — antes do genérico
  app.use('/api/v1/datasets', databricksRouter) // /:id/databricks — antes do genérico
  app.use('/api/v1/datasets', datasetsRouter)
  app.use('/api/v1/databricks', databricksAdminRouter)

  // Biblioteca de métricas e dashboards.
  app.use('/api/v1/metrics', metricsRouter)
  app.use('/api/v1/dashboards', aiWidgetsRouter) // rota /:id/ai/build — antes do genérico
  app.use('/api/v1/dashboards', dashboardsRouter)

  // Chat IA e integrações.
  app.use('/api/v1/ai/providers', aiProvidersRouter) // provedores de IA geridos pela tela
  app.use('/api/v1/ai', aiRouter)
  app.use('/api/v1/credentials', credentialsRouter)
  app.use('/api/v1/products', productsRouter) // construtor de APIs (GET+POST, self-service)
  app.use('/api/v1/gateway', gatewayRouter) // plano de controle: upstreams e política
  app.use('/api/v1/notebooks', notebooksRouter) // análise rápida sobre o lake
  app.use('/api/v1/ml', mlRouter) // modelos preditivos: registro, treino e predicao
  app.use('/api/public/v1', publicRouter)

  app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }))
  return app
}
