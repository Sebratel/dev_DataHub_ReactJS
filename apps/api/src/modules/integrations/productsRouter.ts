// Construtor de APIs (self-service do dev). Produtos de API unificados:
//   • LEITURA (GET): consulta paginada de um dataset acessível — vai ao ar direto.
//   • ESCRITA (POST): INSERT numa conexão gravável — nasce PENDENTE e só ativa
//     depois que um ADMIN aprova (revisão humana antes de qualquer escrita).
// Editores criam os seus; admin vê/edita/aprova todos. Segurança da escrita:
// só conexões marcadas graváveis; consumidor manda só valores (INSERT param.).
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { ApiProduct } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { getConnector } from '../../connectors/registry.js'
import { canQuery } from '../../core/access.js'
import { buildInsert, type WriteColumn } from '../../connectors/writeProducts.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import type { FieldType } from '@datahub/shared'

export const productsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
productsRouter.use(requireAuth({ role: 'editor' }), requireDb)

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'api'
}

function parseColumns(raw: unknown): WriteColumn[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Defina ao menos uma coluna no body.')
  return raw.map((c) => {
    const o = c as Record<string, unknown>
    const col = String(o.col ?? '').trim()
    const type = String(o.type ?? 'text')
    if (!col) throw new Error('Coluna do body sem nome.')
    if (!['text', 'number', 'bool', 'date'].includes(type)) throw new Error(`Tipo inválido no body: ${type}`)
    return { col, type: type as WriteColumn['type'], required: o.required === true }
  })
}

function toProduct(r: Record<string, unknown>): ApiProduct {
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name),
    kind: r.kind as ApiProduct['kind'], method: r.method as ApiProduct['method'],
    ownerEmail: String(r.owner_email), status: r.status as ApiProduct['status'], enabled: !!r.enabled,
    datasetSlug: (r.dataset_slug as string) ?? null, pagination: (r.pagination as ApiProduct['pagination']) ?? null,
    defaultLimit: r.default_limit != null ? Number(r.default_limit) : null,
    maxLimit: r.max_limit != null ? Number(r.max_limit) : null,
    readFilters: (r.read_filters as ApiProduct['readFilters']) ?? null,
    connectionId: (r.connection_id as string) ?? null, schemaName: (r.schema_name as string) ?? null,
    tableName: (r.table_name as string) ?? null, columns: (r.columns as ApiProduct['columns']) ?? null,
    reviewedBy: (r.reviewed_by as string) ?? null, reviewedAt: r.reviewed_at ? String(r.reviewed_at) : null,
    createdAt: String(r.created_at),
  }
}

async function tenantId(slug: string): Promise<string> {
  return String((await db.query('select id from tenants where slug = $1', [slug])).rows[0].id)
}
function isAdmin(req: Request): boolean { return req.user!.roles.includes('admin') }

// Valida a configuração específica do tipo e devolve os campos para gravar.
async function validateConfig(req: Request, body: Record<string, unknown>) {
  const kind = String(body.kind)
  if (kind !== 'read' && kind !== 'write') throw new Error('Tipo deve ser read (GET) ou write (POST).')
  const name = String(body.name ?? '').trim()
  if (!name) throw new Error('Informe o nome da API.')

  if (kind === 'read') {
    const datasetSlug = String(body.datasetSlug ?? '').trim()
    if (!datasetSlug) throw new Error('Escolha o dataset da API de leitura.')
    const ds = (await db.query(
      `select d.id from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1 and d.slug = $2`,
      [req.user!.tenant, datasetSlug],
    )).rows[0]
    if (!ds) throw new Error('Dataset não encontrado.')
    if (!(await canQuery(req.user!, String(ds.id)))) throw new Error('Você não tem acesso a esse dataset.')
    const pagination = body.pagination === 'page' ? 'page' : 'offset'
    const defaultLimit = Number(body.defaultLimit) || 100
    const maxLimit = Math.min(Number(body.maxLimit) || 10_000, 100_000)
    const readFilters = Array.isArray(body.readFilters) ? body.readFilters : []
    return {
      kind, name, method: 'GET' as const,
      datasetSlug, pagination, defaultLimit, maxLimit, readFilters,
      connectionId: null, schemaName: null, tableName: null, columns: null,
    }
  }
  // write
  const connectionId = String(body.connectionId ?? '')
  const def = getConnector(connectionId)
  if (!def) throw new Error('Conexão não encontrada.')
  if (!def.writable) throw new Error('A conexão escolhida não está marcada como GRAVÁVEL.')
  const schemaName = String(body.schema ?? body.schemaName ?? 'public').trim() || 'public'
  const tableName = String(body.table ?? body.tableName ?? '').trim()
  if (!tableName) throw new Error('Informe a tabela de destino.')
  const columns = parseColumns(body.columns)
  return {
    kind, name, method: 'POST' as const,
    datasetSlug: null, pagination: null, defaultLimit: null, maxLimit: null, readFilters: null,
    connectionId, schemaName, tableName, columns,
  }
}

// ── Lista (catálogo de APIs do tenant) ──────────────────────────
productsRouter.get('/', async (req, res) => {
  const rows = (await db.query(
    `select p.* from api_products p join tenants t on t.id = p.tenant_id
      where t.slug = $1 order by p.created_at desc`,
    [req.user!.tenant],
  )).rows
  res.json({ products: rows.map(toProduct) })
})

// Conexões GRAVÁVEIS (só id/nome — sem segredos) para o editor montar escrita.
productsRouter.get('/writable-connections', async (_req, res) => {
  const { allConnectors } = await import('../../connectors/registry.js')
  const list = allConnectors().filter((d) => d.writable).map((d) => ({ id: d.id, name: d.name }))
  res.json({ connections: list })
})

// ── Criar ───────────────────────────────────────────────────────
productsRouter.post('/', async (req, res) => {
  try {
    const cfg = await validateConfig(req, req.body ?? {})
    const tid = await tenantId(req.user!.tenant)
    const base = slugify(cfg.name)
    const taken = new Set((await db.query('select slug from api_products where tenant_id = $1', [tid])).rows.map((r) => r.slug))
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

    // Escrita nasce PENDENTE (aprovação do admin). Se o admin cria, já entra ativa.
    const admin = isAdmin(req)
    const status = cfg.kind === 'write' ? (admin ? 'active' : 'pending') : 'active'
    const reviewed = cfg.kind === 'write' && admin

    const row = (await db.query(
      `insert into api_products
         (tenant_id, slug, name, kind, method, owner_email, status,
          dataset_slug, pagination, default_limit, max_limit, read_filters,
          connection_id, schema_name, table_name, columns, reviewed_by, reviewed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [tid, slug, cfg.name, cfg.kind, cfg.method, req.user!.email, status,
       cfg.datasetSlug, cfg.pagination, cfg.defaultLimit, cfg.maxLimit,
       cfg.readFilters ? JSON.stringify(cfg.readFilters) : null,
       cfg.connectionId, cfg.schemaName, cfg.tableName, cfg.columns ? JSON.stringify(cfg.columns) : null,
       reviewed ? req.user!.email : null, reviewed ? new Date().toISOString() : null],
    )).rows[0]
    await audit(req, 'api-product.create', { type: 'api_product', id: slug }, { kind: cfg.kind, status })
    res.status(201).json({ id: row.id, slug, status })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Localiza o produto no tenant e checa permissão de edição (dono ou admin).
async function findEditable(req: Request): Promise<Record<string, unknown> | null> {
  const row = (await db.query(
    `select p.* from api_products p join tenants t on t.id = p.tenant_id
      where t.slug = $1 and p.id = $2`,
    [req.user!.tenant, req.params.id],
  )).rows[0]
  if (!row) return null
  if (!isAdmin(req) && row.owner_email !== req.user!.email) return null
  return row
}

// ── Editar ──────────────────────────────────────────────────────
productsRouter.patch('/:id', async (req, res) => {
  try {
    const cur = await findEditable(req)
    if (!cur) return res.status(404).json({ error: 'API não encontrada (ou você não é o dono).' })
    const body = { ...req.body, kind: req.body?.kind ?? cur.kind } as Record<string, unknown>
    const cfg = await validateConfig(req, body)
    // Escrita editada por não-admin volta a PENDENTE (re-aprovação).
    const admin = isAdmin(req)
    const status = cfg.kind === 'write' && !admin ? 'pending' : String(cur.status)
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : cur.enabled
    await db.query(
      `update api_products set name=$2, dataset_slug=$3, pagination=$4, default_limit=$5, max_limit=$6,
         read_filters=$7, connection_id=$8, schema_name=$9, table_name=$10, columns=$11,
         status=$12, enabled=$13 where id=$1`,
      [cur.id, cfg.name, cfg.datasetSlug, cfg.pagination, cfg.defaultLimit, cfg.maxLimit,
       cfg.readFilters ? JSON.stringify(cfg.readFilters) : null,
       cfg.connectionId, cfg.schemaName, cfg.tableName, cfg.columns ? JSON.stringify(cfg.columns) : null,
       status, enabled],
    )
    await audit(req, 'api-product.update', { type: 'api_product', id: String(cur.slug) }, { status })
    res.json({ ok: true, status })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// Liga/desliga rápido (sem re-validar tudo).
productsRouter.patch('/:id/enabled', async (req, res) => {
  const cur = await findEditable(req)
  if (!cur) return res.status(404).json({ error: 'API não encontrada.' })
  await db.query('update api_products set enabled=$2 where id=$1', [cur.id, req.body?.enabled === true])
  res.json({ ok: true })
})

// ── Excluir ─────────────────────────────────────────────────────
productsRouter.delete('/:id', async (req, res) => {
  const cur = await findEditable(req)
  if (!cur) return res.status(404).json({ error: 'API não encontrada (ou você não é o dono).' })
  await db.query('delete from api_products where id=$1', [cur.id])
  await audit(req, 'api-product.delete', { type: 'api_product', id: String(cur.slug) })
  res.json({ ok: true })
})

// ── Testar (sem publicar) ───────────────────────────────────────
// Leitura: roda a consulta (limit 5). Escrita: DRY-RUN — monta o INSERT e valida
// o body, mas NÃO executa (evita gravar lixo no banco interno durante o teste).
productsRouter.post('/:id/test', async (req, res) => {
  try {
    const cur = await findEditable(req)
    if (!cur) return res.status(404).json({ error: 'API não encontrada.' })
    if (cur.kind === 'read') {
      const ds = (await db.query(
        `select d.* from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1 and d.slug = $2`,
        [req.user!.tenant, cur.dataset_slug],
      )).rows[0]
      if (!ds) return res.status(404).json({ error: 'Dataset não encontrado.' })
      const dir = datasetDir(req.user!.tenant, String(ds.slug))
      if (!listParquet(dir).length) return res.status(409).json({ error: 'Dataset ainda não sincronizado.' })
      const fields = (await db.query(
        `select key, type, sensitive from dataset_fields where dataset_id = $1 and not hidden order by sort_order`,
        [ds.id],
      )).rows as { key: string; type: FieldType; sensitive: boolean }[]
      const filters = Array.isArray(cur.read_filters) ? cur.read_filters : []
      const compiled = compileQuery({ dataset: String(ds.slug), filters, limit: 5 }, fields, { admin: false, glob: parquetGlob(dir) })
      const { rows } = await duckQuery(compiled.sql, compiled.params)
      return res.json({ ok: true, kind: 'read', rows })
    }
    // write — dry-run
    const def = getConnector(String(cur.connection_id))
    if (!def || (def.kind !== 'postgres' && def.kind !== 'mysql')) return res.status(400).json({ error: 'Conexão inválida.' })
    const { sql, params } = buildInsert(def.kind, String(cur.schema_name), String(cur.table_name), cur.columns as WriteColumn[], (req.body?.body ?? {}) as Record<string, unknown>)
    res.json({ ok: true, kind: 'write', dryRun: true, sql, params })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ── Aprovação (ADMIN) ───────────────────────────────────────────
productsRouter.post('/:id/approve', requireAuth({ role: 'admin' }), async (req, res) => {
  const row = (await db.query(
    `update api_products p set status='active', enabled=true, reviewed_by=$3, reviewed_at=now()
       from tenants t where p.tenant_id=t.id and t.slug=$1 and p.id=$2 and p.kind='write' returning p.slug`,
    [req.user!.tenant, req.params.id, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'API de escrita pendente não encontrada.' })
  await audit(req, 'api-product.approve', { type: 'api_product', id: String(row.slug) })
  res.json({ ok: true })
})

productsRouter.post('/:id/reject', requireAuth({ role: 'admin' }), async (req, res) => {
  const row = (await db.query(
    `update api_products p set status='rejected', enabled=false, reviewed_by=$3, reviewed_at=now()
       from tenants t where p.tenant_id=t.id and t.slug=$1 and p.id=$2 and p.kind='write' returning p.slug`,
    [req.user!.tenant, req.params.id, req.user!.email],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'API de escrita não encontrada.' })
  await audit(req, 'api-product.reject', { type: 'api_product', id: String(row.slug) }, { reason: req.body?.reason ?? null })
  res.json({ ok: true })
})
