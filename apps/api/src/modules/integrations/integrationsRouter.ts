// ─────────────────────────────────────────────────────────────────────────
// Integrações: tokens de acesso + API pública de leitura.
//   Autenticado:  GET/POST/DELETE /api/v1/credentials   (gestão de tokens)
//   Público:      GET /public/v1/datasets/:slug/rows?token=…&format=csv|json
// O token é exibido UMA única vez na criação; só o hash é guardado.
// A API pública roda como NÃO-admin: sensíveis mascarados, ocultos fora.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import type { FieldType, ApiWriteOp } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { executeWrite, type WriteColumn } from '../../connectors/writeProducts.js'

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

// ─── Gestão de tokens (autenticado) ────────────────────────────
export const credentialsRouter = Router()

credentialsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.name, c.dataset_slugs, c.owner_email, c.revoked, c.last_used_at, c.expires_at, c.created_at
       from api_credentials c join tenants t on t.id = c.tenant_id
      where t.slug = $1 order by c.created_at desc`,
    [req.user!.tenant],
  )).rows
  res.json({ credentials: rows })
})

credentialsRouter.post('/', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { name, datasetSlugs, writeSlugs, expiresInDays } = req.body ?? {}
  if (!name) return res.status(400).json({ error: 'Informe um nome para o token.' })
  // Escopo de escrita só admin concede (leitura pode editor).
  const writes = Array.isArray(writeSlugs) && req.user!.roles.includes('admin') ? writeSlugs : []
  const token = `dhub_${randomBytes(24).toString('base64url')}`
  const expiresAt = Number(expiresInDays) > 0
    ? new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
    : null
  const row = (await db.query(
    `insert into api_credentials (tenant_id, name, token_hash, dataset_slugs, write_slugs, owner_email, expires_at)
     select t.id, $1, $2, $3, $4, $5, $6 from tenants t where t.slug = $7 returning id`,
    [String(name).trim(), hash(token), Array.isArray(datasetSlugs) ? datasetSlugs : [], writes,
     req.user!.email, expiresAt, req.user!.tenant],
  )).rows[0]
  await audit(req, 'credentials.create', { type: 'credential', id: String(row.id) }, { name })
  // O token em claro só existe nesta resposta.
  res.status(201).json({ id: row.id, token })
})

credentialsRouter.delete('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const row = (await db.query(
    `update api_credentials set revoked = true where id = $1 returning name`,
    [req.params.id],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Token não encontrado.' })
  await audit(req, 'credentials.revoke', { type: 'credential', id: req.params.id }, { name: row.name })
  res.json({ ok: true })
})

// ─── API pública (token) ───────────────────────────────────────
export const publicRouter = Router()

// Monitoramento automático: TODA chamada da API pública (as APIs que os devs
// pegam em Integrações) é registrada em api_call_metrics → painel "Saúde das
// APIs". Best-effort: nunca atrapalha a resposta. O handler enriquece via
// res.locals (consumidor/token, dataset, nº de linhas).
function monitorPublicApi(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now()
  res.on('finish', () => {
    const status = res.statusCode
    const bytes = Number(res.getHeader('content-length')) || 0
    const locals = res.locals as { consumer?: string; dataSlug?: string; rows?: number }
    void db.query(
      `insert into api_call_metrics (dataset_slug, connection_id, endpoint, status, ok, duration_ms, rows, bytes, error, check_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'public')`,
      [locals.dataSlug ?? null, locals.consumer ?? null, (req.originalUrl || '').split('?')[0],
       status, status < 400, Date.now() - started, locals.rows ?? null, bytes,
       status >= 400 ? `HTTP ${status}` : null],
    ).catch(() => { /* métrica é best-effort */ })
  })
  next()
}
publicRouter.use(monitorPublicApi)

publicRouter.get('/datasets/:slug/rows', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Serviço indisponível.' })
  const token = String(req.query.token ?? req.headers['x-api-token'] ?? '')
  if (!token) return res.status(401).json({ error: 'Token ausente (?token=… ou header X-Api-Token).' })

  const cred = (await db.query(
    `select c.*, t.slug as tenant_slug from api_credentials c
      join tenants t on t.id = c.tenant_id where c.token_hash = $1`,
    [hash(token)],
  )).rows[0]
  if (!cred || cred.revoked) return res.status(401).json({ error: 'Token inválido ou revogado.' })
  if (cred.expires_at && new Date(cred.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Token expirado.' })
  }
  res.locals.consumer = cred.name // quem chamou (p/ o monitoramento)
  const slugs = (cred.dataset_slugs as string[]) ?? []
  if (slugs.length && !slugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este conjunto de dados.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [cred.tenant_slug, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  res.locals.dataSlug = ds.slug
  const dir = datasetDir(String(cred.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) return res.status(409).json({ error: 'Conjunto ainda não sincronizado.' })

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean; label: string }[]

  const limit = Math.min(Math.max(1, Number(req.query.limit) || 10_000), 100_000)
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const format = String(req.query.format ?? (req.headers.accept === 'text/csv' ? 'csv' : 'json'))

  try {
    // Sempre como NÃO-admin: sensíveis mascarados, ocultos inexistentes.
    const compiled = compileQuery({ dataset: String(ds.slug), limit, offset }, fields, {
      admin: false, glob: parquetGlob(dir),
    })
    const { columns, rows } = await duckQuery(compiled.sql, compiled.params)
    res.locals.rows = rows.length
    const total = Number((await duckQuery(compiled.countSql!, compiled.countParams)).rows[0]?.n ?? 0)
    await db.query(`update api_credentials set last_used_at = now() where id = $1`, [cred.id])

    if (format === 'csv') {
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return ''
        const s = String(v)
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const lines = [columns.join(';')]
      for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(';'))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.send('﻿' + lines.join('\r\n'))
      return
    }
    res.json({ dataset: ds.slug, total, limit, offset, rows })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ─── Escrita: INSERT (POST) / UPDATE (PUT,PATCH) / DELETE ───────────────────
// O consumidor manda só VALORES; o SQL é montado pelo servidor a partir da
// definição aprovada. UPDATE/DELETE exigem filtro (where) e respeitam o teto de
// linhas (transação + rollback). Auditado + monitorado (middleware do publicRouter).
publicRouter.all('/w/:slug', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Serviço indisponível.' })
  const token = String(req.query.token ?? req.headers['x-api-token'] ?? '')
  if (!token) return res.status(401).json({ error: 'Token ausente (?token=… ou header X-Api-Token).' })

  const cred = (await db.query(
    `select c.*, t.slug as tenant_slug from api_credentials c
      join tenants t on t.id = c.tenant_id where c.token_hash = $1`,
    [hash(token)],
  )).rows[0]
  if (!cred || cred.revoked) return res.status(401).json({ error: 'Token inválido ou revogado.' })
  if (cred.expires_at && new Date(cred.expires_at) < new Date()) return res.status(401).json({ error: 'Token expirado.' })
  res.locals.consumer = cred.name

  const writeSlugs = (cred.write_slugs as string[]) ?? []
  if (!writeSlugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este produto de escrita.' })
  }
  // Só produtos de ESCRITA APROVADOS (status active) e ativos são chamáveis —
  // rascunhos/pendentes de aprovação do admin NUNCA executam.
  const p = (await db.query(
    `select * from api_products where tenant_id = $1 and slug = $2 and kind = 'write' and status = 'active' and enabled`,
    [cred.tenant_id, req.params.slug],
  )).rows[0]
  if (!p) return res.status(404).json({ error: 'API de escrita não encontrada, desativada ou ainda não aprovada.' })
  res.locals.dataSlug = p.slug

  // O verbo HTTP tem de casar com a operação definida (evita chamar DELETE num
  // endpoint de INSERT por engano). PUT e PATCH são ambos aceitos p/ update.
  const op = (p.write_op as ApiWriteOp) ?? 'insert'
  const allowedMethods = op === 'insert' ? ['POST'] : op === 'update' ? ['PUT', 'PATCH'] : ['DELETE']
  if (!allowedMethods.includes(req.method)) {
    res.setHeader('Allow', allowedMethods.join(', '))
    return res.status(405).json({ error: `Esta API é de ${op}; use ${allowedMethods.join(' ou ')}.` })
  }

  try {
    // Corpo: insert → valores planos (ou {values}); update → {set, where}; delete → {where}.
    // No DELETE, filtros também podem vir na query string (?id=123).
    const raw = (req.body ?? {}) as Record<string, unknown>
    const payload = op === 'insert'
      ? { values: (raw.values as Record<string, unknown>) ?? raw }
      : op === 'update'
        ? { set: (raw.set as Record<string, unknown>) ?? {}, where: (raw.where as Record<string, unknown>) ?? {} }
        : { where: (raw.where as Record<string, unknown>) ?? (Object.keys(raw).length ? raw : (req.query as Record<string, unknown>)) }

    const result = await executeWrite(
      {
        op, connectionId: String(p.connection_id), schema: String(p.schema_name), table: String(p.table_name),
        columns: (p.columns as WriteColumn[]) ?? [], keyColumns: (p.key_columns as WriteColumn[]) ?? [],
        maxAffected: p.max_affected != null ? Number(p.max_affected) : null,
      },
      payload,
    )
    res.locals.rows = result.rowCount
    await db.query(`update api_credentials set last_used_at = now() where id = $1`, [cred.id])
    await db.query(
      `insert into audit_logs (tenant_id, user_email, action, resource_type, resource_id, detail, ip)
       values ($1, $2, $3, 'api_product', $4, $5, $6)`,
      [cred.tenant_id, cred.name, `api-product.${op}`, p.slug,
       JSON.stringify({ affected: result.rowCount, method: req.method }), req.ip ?? null],
    )
    res.status(op === 'insert' ? 201 : 200).json({ ok: true, op, affected: result.rowCount, returned: result.rows[0] ?? null })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ─── Leitura: produto de API GET → consulta paginada de um dataset ──────────
// Endpoint nomeado que o dev configurou (paginação page/offset + filtros fixos).
// Roda como NÃO-admin (sensíveis mascarados); o token precisa alcançar o dataset.
publicRouter.get('/p/:slug', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Serviço indisponível.' })
  const token = String(req.query.token ?? req.headers['x-api-token'] ?? '')
  if (!token) return res.status(401).json({ error: 'Token ausente (?token=… ou header X-Api-Token).' })

  const cred = (await db.query(
    `select c.*, t.slug as tenant_slug from api_credentials c
      join tenants t on t.id = c.tenant_id where c.token_hash = $1`,
    [hash(token)],
  )).rows[0]
  if (!cred || cred.revoked) return res.status(401).json({ error: 'Token inválido ou revogado.' })
  if (cred.expires_at && new Date(cred.expires_at) < new Date()) return res.status(401).json({ error: 'Token expirado.' })
  res.locals.consumer = cred.name

  const p = (await db.query(
    `select * from api_products where tenant_id = $1 and slug = $2 and kind = 'read' and status = 'active' and enabled`,
    [cred.tenant_id, req.params.slug],
  )).rows[0]
  if (!p) return res.status(404).json({ error: 'API de leitura não encontrada ou desativada.' })

  // O token precisa alcançar o dataset por trás do produto (escopo de leitura).
  const allowed = (cred.dataset_slugs as string[]) ?? []
  if (allowed.length && !allowed.includes(String(p.dataset_slug))) {
    return res.status(403).json({ error: 'Este token não tem acesso ao dataset desta API.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1 and d.slug = $2`,
    [cred.tenant_slug, p.dataset_slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Dataset da API não encontrado.' })
  res.locals.dataSlug = ds.slug
  const dir = datasetDir(String(cred.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) return res.status(409).json({ error: 'Dataset ainda não sincronizado.' })

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean; label: string }[]

  // Paginação conforme o produto: 'page' (page/size) ou 'offset' (offset/limit).
  const maxLimit = Math.min(Number(p.max_limit) || 10_000, 100_000)
  const defLimit = Math.min(Math.max(1, Number(p.default_limit) || 100), maxLimit)
  let limit = defLimit
  let offset = 0
  let page: number | null = null
  if (p.pagination === 'page') {
    const size = Math.min(Math.max(1, Number(req.query.size) || defLimit), maxLimit)
    page = Math.max(1, Number(req.query.page) || 1)
    limit = size
    offset = (page - 1) * size
  } else {
    limit = Math.min(Math.max(1, Number(req.query.limit) || defLimit), maxLimit)
    offset = Math.max(0, Number(req.query.offset) || 0)
  }
  const format = String(req.query.format ?? (req.headers.accept === 'text/csv' ? 'csv' : 'json'))

  try {
    const filters = Array.isArray(p.read_filters) ? p.read_filters : []
    const compiled = compileQuery({ dataset: String(ds.slug), filters, limit, offset }, fields, {
      admin: false, glob: parquetGlob(dir),
    })
    const { columns, rows } = await duckQuery(compiled.sql, compiled.params)
    res.locals.rows = rows.length
    const total = Number((await duckQuery(compiled.countSql!, compiled.countParams)).rows[0]?.n ?? 0)
    await db.query(`update api_credentials set last_used_at = now() where id = $1`, [cred.id])

    if (format === 'csv') {
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return ''
        const s = String(v)
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const lines = [columns.join(';')]
      for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(';'))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.send('﻿' + lines.join('\r\n'))
      return
    }
    res.json({ api: p.slug, dataset: ds.slug, total, limit, ...(page !== null ? { page } : { offset }), rows })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
