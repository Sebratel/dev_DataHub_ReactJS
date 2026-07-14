// Administração de conexões (fontes de dados). Somente admin.
// A descoberta é 100% generalista (information_schema) — nada de negócio aqui.
import { Router } from 'express'
import type { ConnectionInfo } from '@datahub/shared'
import { CONNECTORS, isConfigured } from '../../connectors/registry.js'
import { checkConnection, discoverObjects, discoverColumns } from '../../connectors/pools.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const connectionsRouter = Router()

connectionsRouter.use(requireAuth({ role: 'admin' }))

// Lista as fontes com status ao vivo (SELECT 1 barato em cada uma).
connectionsRouter.get('/', async (_req, res) => {
  const infos: ConnectionInfo[] = await Promise.all(
    CONNECTORS.map(async (def) => {
      const configured = isConfigured(def)
      if (!configured) {
        return { id: def.id, name: def.name, kind: def.kind, envPrefix: def.envPrefix,
                 configured, status: 'unknown' as const, latencyMs: null, error: null }
      }
      const check = await checkConnection(def.id)
      return { id: def.id, name: def.name, kind: def.kind, envPrefix: def.envPrefix,
               configured, status: check.ok ? 'ok' as const : 'error' as const,
               latencyMs: check.latencyMs, error: check.error ?? null }
    }),
  )
  res.json({ connections: infos })
})

// Tabelas/views da fonte — matéria-prima para publicar datasets.
connectionsRouter.get('/:id/objects', async (req, res) => {
  try {
    const objects = await discoverObjects(req.params.id)
    await audit(req, 'connections.discover', { type: 'connection', id: req.params.id })
    res.json({ objects })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Colunas de um objeto físico.
connectionsRouter.get('/:id/objects/:schema/:table/columns', async (req, res) => {
  try {
    const { id, schema, table } = req.params
    const columns = await discoverColumns(id, schema, table)
    res.json({ columns })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
