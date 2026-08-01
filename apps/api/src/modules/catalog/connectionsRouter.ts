// Administração de conexões (fontes de dados). Somente admin.
// Fontes FIXAS (.env) aparecem só-leitura; fontes GERENCIADAS (cadastradas aqui)
// podem ser criadas/editadas/excluídas. A descoberta é generalista
// (information_schema). Credenciais nunca voltam ao frontend.
import { Router } from 'express'
import type { ConnectionInfo } from '@datahub/shared'
import { allConnectors, getConnector, isConfigured, envDetail, RESERVED_IDS, type ConnectorKind } from '../../connectors/registry.js'
import { checkConnection, discoverObjects, discoverColumns, testParams } from '../../connectors/pools.js'
import { testHttp } from '../../connectors/httpSource.js'
import { createConnection, updateConnection, deleteConnection, datasetsUsing, type ConnectionInput } from '../../connectors/store.js'
import { hasSecret } from '../../core/crypto.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const connectionsRouter = Router()

connectionsRouter.use(requireAuth({ role: 'admin' }))

// Valida e normaliza o corpo de uma conexão gerenciada (SQL ou HTTP).
function parseInput(body: unknown): ConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>
  const kind = String(b.kind) as ConnectorKind
  if (kind !== 'postgres' && kind !== 'mysql' && kind !== 'http') {
    throw new Error('Tipo deve ser postgres, mysql ou http.')
  }
  const name = String(b.name ?? '').trim()
  if (!name) throw new Error('Informe o nome.')
  if (kind === 'http') {
    const baseUrl = String(b.baseUrl ?? '').trim()
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Informe uma baseUrl válida (http:// ou https://).')
    return {
      name, kind: 'http', ssl: b.ssl === true, baseUrl,
      authHeader: b.authHeader ? String(b.authHeader).trim() : undefined,
      authScheme: b.authScheme ? String(b.authScheme).trim() : undefined,
      token: b.token ? String(b.token) : undefined,
    }
  }
  const host = String(b.host ?? '').trim()
  const database = String(b.database ?? '').trim()
  const username = String(b.username ?? '').trim()
  const port = Number(b.port) || (kind === 'mysql' ? 3306 : 5432)
  if (!host || !database || !username) throw new Error('Preencha host, banco e usuário.')
  return {
    name, kind, host, port, database, username,
    password: b.password ? String(b.password) : undefined,
    ssl: b.ssl === true,
  }
}

// Lista as fontes (fixas + gerenciadas) com status ao vivo (SELECT 1).
connectionsRouter.get('/', async (_req, res) => {
  const infos: ConnectionInfo[] = await Promise.all(
    allConnectors().map(async (def) => {
      const configured = isConfigured(def)
      const detail = def.config
        ? { host: def.config.host, port: def.config.port, database: def.config.database, username: def.config.user, ssl: def.config.ssl }
        : envDetail(def)
      const base = {
        id: def.id, name: def.name, kind: def.kind, envPrefix: def.envPrefix ?? null,
        managed: !!def.managed, native: RESERVED_IDS.has(def.id), configured, detail,
      }
      if (!configured) return { ...base, status: 'unknown' as const, latencyMs: null, error: null }
      const check = await checkConnection(def.id)
      return { ...base, status: check.ok ? 'ok' as const : 'error' as const, latencyMs: check.latencyMs, error: check.error ?? null }
    }),
  )
  res.json({ connections: infos })
})

// Testa parâmetros avulsos ANTES de salvar (não persiste nada).
connectionsRouter.post('/test', async (req, res) => {
  try {
    const input = parseInput(req.body)
    if (input.kind === 'http') {
      const r = await testHttp(input.baseUrl!, { header: input.authHeader, scheme: input.authScheme, token: input.token })
      return res.json({ ok: r.ok, latencyMs: r.latencyMs, status: r.status, error: r.ok ? undefined : r.error })
    }
    if (!input.password) return res.status(400).json({ error: 'Informe a senha para testar.' })
    const r = await testParams({
      kind: input.kind, host: input.host!, port: input.port!, database: input.database!,
      user: input.username!, password: input.password, ssl: input.ssl,
    })
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Cria uma conexão gerenciada (senha criptografada em repouso).
connectionsRouter.post('/', async (req, res) => {
  if (!hasSecret()) return res.status(400).json({ error: 'CONNECTIONS_SECRET não configurado no servidor — necessário para guardar a senha com segurança.' })
  try {
    const input = parseInput(req.body)
    const id = await createConnection(input, req.user!.email)
    await audit(req, 'connections.create', { type: 'connection', id }, { kind: input.kind, host: input.host })
    res.status(201).json({ id })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Edita uma gerenciada OU personaliza uma nativa (sobrepõe o .env pelo mesmo id).
// Senha em branco: mantém a atual, ou semeia a do .env na 1ª personalização.
connectionsRouter.patch('/:id', async (req, res) => {
  if (!hasSecret()) return res.status(400).json({ error: 'CONNECTIONS_SECRET não configurado no servidor.' })
  try {
    const input = parseInput(req.body)
    await updateConnection(req.params.id, input, req.user!.email)
    await audit(req, 'connections.update', { type: 'connection', id: req.params.id },
      { kind: input.kind, host: input.host, override: RESERVED_IDS.has(req.params.id) })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Exclui uma gerenciada; numa nativa personalizada, REVERTE para o .env.
connectionsRouter.delete('/:id', async (req, res) => {
  const def = getConnector(req.params.id)
  if (!def) return res.status(404).json({ error: 'Conexão não encontrada.' })
  const native = RESERVED_IDS.has(req.params.id)
  if (native && !def.managed) {
    return res.status(400).json({ error: 'Conexão fixa (.env) sem personalização — nada para excluir. Edite o .env do servidor.' })
  }
  // Nativa personalizada: excluir só remove a sobreposição (reverte ao .env), os
  // datasets continuam funcionando — sem aviso de uso. Gerenciada pura: avisa.
  if (!native) {
    const inUse = await datasetsUsing(req.params.id)
    if (inUse > 0 && req.query.force !== 'true') {
      return res.status(409).json({ error: `Há ${inUse} conjunto(s) usando esta conexão. Reenvie com ?force=true para excluir mesmo assim.` })
    }
  }
  await deleteConnection(req.params.id)
  await audit(req, 'connections.delete', { type: 'connection', id: req.params.id }, { reverted: native })
  res.json({ ok: true })
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
