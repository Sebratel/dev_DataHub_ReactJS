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

// Admin: fontes de dados.
app.use('/api/v1/connections', connectionsRouter)

// Catálogo de conjuntos de dados.
app.use('/api/v1/datasets', datasetsRouter)

app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }))

await runMigrations()
app.listen(config.apiPort, () => {
  console.log(`[api] Data Hub API em http://localhost:${config.apiPort}`)
})
