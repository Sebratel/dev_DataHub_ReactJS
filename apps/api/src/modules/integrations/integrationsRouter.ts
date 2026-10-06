// ─────────────────────────────────────────────────────────────────────────
// Integrações: tokens de acesso + API pública de leitura.
//   Autenticado:  GET/POST/PATCH/DELETE /api/v1/credentials  (gestão de tokens)
//   Público:      GET  /public/v1/datasets/:slug/rows?token=…&format=csv|json
//                 POST /public/v1/datasets/:slug/query   (QueryDef → resultado)
// O token é exibido UMA única vez na criação; só o hash é guardado.
// A API pública roda como NÃO-admin: sensíveis mascarados, ocultos fora.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import type { FieldType, ApiWriteOp, QueryDef, QueryFilter } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { executeWrite, type WriteColumn } from '../../connectors/writeProducts.js'
import {
  admit, isDenied, readToken, recordCall, requestIdOf, sendDenied, type Consumer,
} from '../gateway/policy.js'

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

// ─── Gestão de tokens (autenticado) ────────────────────────────
export const credentialsRouter = Router()

credentialsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.name, c.dataset_slugs, c.write_slugs, c.owner_email, c.revoked, c.last_used_at, c.expires_at, c.created_at
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

// Edição de um token já criado. O SEGREDO em si é imutável — só o hash existe
// aqui, e nem nós conseguimos recuperá-lo. O que se edita é o entorno: nome,
// escopo de leitura, escopo de escrita, validade e o liga/desliga.
//
// Revogar e excluir são coisas DIFERENTES e ambas precisam existir:
//   revogar  → o token para de funcionar mas continua na lista, com o histórico
//              de uso preservado. É o certo para um token que vazou.
//   excluir  → some de vez. É o certo para um token criado por engano, ou para
//              limpar a tela depois que a integração morreu.
// Antes só existia "revogar" (disfarçado de DELETE), e por isso a lista só
// crescia.
credentialsRouter.patch('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const cur = (await db.query(
    `select c.* from api_credentials c join tenants t on t.id = c.tenant_id
      where c.id = $1 and t.slug = $2`,
    [req.params.id, req.user!.tenant],
  )).rows[0]
  if (!cur) return res.status(404).json({ error: 'Token não encontrado.' })

  const { name, datasetSlugs, writeSlugs, expiresInDays, revoked } = req.body ?? {}
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'O nome não pode ficar vazio.' })
  }
  // Escopo de ESCRITA só admin mexe — mesma regra da criação. Um editor que
  // edita o token não pode se autoconceder escrita por esta porta.
  if (writeSlugs !== undefined && !req.user!.roles.includes('admin')) {
    return res.status(403).json({ error: 'Só um administrador altera as APIs de escrita de um token.' })
  }

  // expiresInDays: ausente = não mexe; null = sem validade; N = N dias a partir
  // de agora (renovar a validade é o gesto esperado ao editar isto).
  let expiresAt: string | null | undefined
  if (expiresInDays !== undefined) {
    expiresAt = Number(expiresInDays) > 0
      ? new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
      : null
  }

  try {
    const row = (await db.query(
      `update api_credentials set
         name          = coalesce($2::text, name),
         dataset_slugs = coalesce($3::text[], dataset_slugs),
         write_slugs   = coalesce($4::text[], write_slugs),
         expires_at    = case when $5 then $6::timestamptz else expires_at end,
         revoked       = coalesce($7::boolean, revoked)
       where id = $1
       returning id, name, dataset_slugs, write_slugs, owner_email, revoked,
                 last_used_at, expires_at, created_at`,
      [
        req.params.id,
        name !== undefined ? String(name).trim() : null,
        Array.isArray(datasetSlugs) ? datasetSlugs : null,
        Array.isArray(writeSlugs) ? writeSlugs : null,
        expiresAt !== undefined, expiresAt ?? null,
        typeof revoked === 'boolean' ? revoked : null,
      ],
    )).rows[0]
    await audit(req, 'credentials.update', { type: 'credential', id: req.params.id },
      { name: row.name, revoked: row.revoked })
    res.json({ credential: row })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Exclusão DEFINITIVA. Restrita ao dono ou admin: revogar é reversível e
// qualquer editor pode fazer, mas apagar o token de outra pessoa não.
//
// As FKs já estavam preparadas para isto: a contagem de quota some junto
// (on delete cascade) e a telemetria sobrevive perdendo só a atribuição
// (on delete set null) — o nome do consumidor continua gravado em cada
// chamada, então os painéis de uso histórico não mudam.
credentialsRouter.delete('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const cur = (await db.query(
    `select c.id, c.name, c.owner_email from api_credentials c join tenants t on t.id = c.tenant_id
      where c.id = $1 and t.slug = $2`,
    [req.params.id, req.user!.tenant],
  )).rows[0]
  if (!cur) return res.status(404).json({ error: 'Token não encontrado.' })
  if (cur.owner_email !== req.user!.email && !req.user!.roles.includes('admin')) {
    return res.status(403).json({
      error: 'Só quem criou o token (ou um administrador) pode excluí-lo. Você pode revogá-lo.',
    })
  }
  await db.query('delete from api_credentials where id = $1', [req.params.id])
  await audit(req, 'credentials.delete', { type: 'credential', id: req.params.id }, { name: cur.name })
  res.json({ ok: true })
})

// ─── API pública (token) ───────────────────────────────────────
export const publicRouter = Router()

// PORTÃO ÚNICO de toda a API pública. Antes cada endpoint repetia a checagem de
// token — e nenhum deles tinha limite de uso, então um consumidor em laço
// ocupava os slots do motor de consulta e derrubava a latência dos painéis.
// Agora: autentica → rate limit → quota, num lugar só (gateway/policy.ts).
//
// A telemetria sai daqui também, com atribuição por credential_id (a coluna
// connection_id segue recebendo o NOME do consumidor para não quebrar os
// painéis existentes que já leem dela).
function publicGate(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now()
  const requestId = requestIdOf(req)
  res.setHeader('X-Request-Id', requestId)

  res.on('finish', () => {
    const locals = res.locals as { consumer?: Consumer; dataSlug?: string; rows?: number }
    recordCall({
      checkType: 'public',
      requestId,
      method: req.method,
      endpoint: (req.originalUrl || '').split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - started,
      credentialId: locals.consumer?.id ?? null,
      consumerName: locals.consumer?.name ?? null,
      datasetSlug: locals.dataSlug ?? null,
      rows: locals.rows ?? null,
      bytes: Number(res.getHeader('content-length')) || 0,
      error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
      ip: req.ip ?? null,
    })
  })

  if (!isDbAvailable()) { res.status(503).json({ error: 'Serviço indisponível.' }); return }

  void admit(readToken(req)).then((result) => {
    if (isDenied(result)) return sendDenied(res, result)
    res.locals.consumer = result
    next()
  }).catch((e: Error) => {
    res.status(500).json({ error: `Falha ao validar o token: ${e.message}` })
  })
}
publicRouter.use(publicGate)

publicRouter.get('/datasets/:slug/rows', async (req, res) => {
  const cred = res.locals.consumer as Consumer
  const slugs = cred.datasetSlugs
  if (slugs.length && !slugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este conjunto de dados.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [cred.tenantSlug, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  res.locals.dataSlug = ds.slug
  const dir = datasetDir(String(cred.tenantSlug), String(ds.slug))
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
    // maxLimit igual ao teto anunciado: sem isto o compilador cortava em 10 mil
    // e a API entregava menos do que dizia aceitar, sem avisar.
    const compiled = compileQuery({ dataset: String(ds.slug), limit, offset }, fields, {
      admin: false, glob: parquetGlob(dir), maxLimit: 100_000,
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

// ─── Consulta: o MESMO QueryDef dos painéis, pelo token ────────────────────
// Para quem lê o lake de fora — outra aplicação montando painéis. Pelo /rows
// ela precisava baixar o conjunto inteiro e agregar do lado de lá, o que não
// para em pé com milhões de linhas: aqui ela manda o QueryDef e recebe só o
// resultado, agregado pelo DuckDB sobre o Parquet.
//
// Nada de novo em permissão: é o compilador do /api/v1/datasets/:slug/query,
// rodando como NÃO-admin (sensíveis mascarados no select e proibidos em
// filtro/agrupamento/ordenação, ocultos inexistentes), com o escopo de leitura
// do token e o limite/cota do portão. Agregar também não revela nada que o
// /rows já não entregue. E das telas vêm o tempo limite das consultas
// interativas e o teto de 10 mil linhas por resposta.
publicRouter.post('/datasets/:slug/query', async (req, res) => {
  const cred = res.locals.consumer as Consumer
  const slugs = cred.datasetSlugs
  if (slugs.length && !slugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este conjunto de dados.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [cred.tenantSlug, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  res.locals.dataSlug = ds.slug
  const dir = datasetDir(String(cred.tenantSlug), String(ds.slug))
  if (!listParquet(dir).length) return res.status(409).json({ error: 'Conjunto ainda não sincronizado.' })

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean }[]
  // Métricas da biblioteca, para o select {metric: slug} valer aqui também.
  const metrics = (await db.query(
    `select slug, agg, field_key, filters from metrics where dataset_id = $1`,
    [ds.id],
  )).rows.map((m) => ({
    slug: String(m.slug), agg: String(m.agg), fieldKey: String(m.field_key),
    filters: (m.filters ?? []) as QueryFilter[],
  }))

  const started = Date.now()
  try {
    const def = (req.body ?? {}) as QueryDef
    const compiled = compileQuery({ ...def, dataset: String(ds.slug) }, fields, {
      admin: false, glob: parquetGlob(dir), metrics,
    })
    const timeoutMs = config.duck.queryTimeoutMs
    const result = await duckQuery(compiled.sql, compiled.params, { timeoutMs })
    res.locals.rows = result.rows.length
    const total = compiled.countSql
      ? Number((await duckQuery(compiled.countSql, compiled.countParams, { timeoutMs })).rows[0]?.n ?? 0)
      : undefined
    await db.query(`update api_credentials set last_used_at = now() where id = $1`, [cred.id])
    const typeByKey = new Map(fields.map((f) => [f.key, f.type]))
    res.json({
      dataset: ds.slug,
      columns: result.columns.map((name) => ({ name, type: typeByKey.get(name) ?? 'text' })),
      rows: result.rows,
      total,
      tookMs: Date.now() - started,
    })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ─── Escrita: INSERT (POST) / UPDATE (PUT,PATCH) / DELETE ───────────────────
// O consumidor manda só VALORES; o SQL é montado pelo servidor a partir da
// definição aprovada. UPDATE/DELETE exigem filtro (where) e respeitam o teto de
// linhas (transação + rollback). Auditado + monitorado (middleware do publicRouter).
publicRouter.all('/w/:slug', async (req, res) => {
  const cred = res.locals.consumer as Consumer

  const writeSlugs = cred.writeSlugs
  if (!writeSlugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este produto de escrita.' })
  }
  // Só produtos de ESCRITA APROVADOS (status active) e ativos são chamáveis —
  // rascunhos/pendentes de aprovação do admin NUNCA executam.
  const p = (await db.query(
    `select * from api_products where tenant_id = $1 and slug = $2 and kind = 'write' and status = 'active' and enabled`,
    [cred.tenantId, req.params.slug],
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
      [cred.tenantId, cred.name, `api-product.${op}`, p.slug,
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
  const cred = res.locals.consumer as Consumer

  const p = (await db.query(
    `select * from api_products where tenant_id = $1 and slug = $2 and kind = 'read' and status = 'active' and enabled`,
    [cred.tenantId, req.params.slug],
  )).rows[0]
  if (!p) return res.status(404).json({ error: 'API de leitura não encontrada ou desativada.' })

  // O token precisa alcançar o dataset por trás do produto (escopo de leitura).
  const allowed = cred.datasetSlugs
  if (allowed.length && !allowed.includes(String(p.dataset_slug))) {
    return res.status(403).json({ error: 'Este token não tem acesso ao dataset desta API.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1 and d.slug = $2`,
    [cred.tenantSlug, p.dataset_slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Dataset da API não encontrado.' })
  res.locals.dataSlug = ds.slug
  const dir = datasetDir(String(cred.tenantSlug), String(ds.slug))
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
      admin: false, glob: parquetGlob(dir), maxLimit: 100_000,
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
