// Admin › Produtos de Escrita (Fase 4). Define endpoints públicos que fazem
// INSERT parametrizado numa conexão gravável. SOMENTE ADMIN cria/edita/exclui —
// é a revisão humana antes de qualquer API de escrita existir.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { getConnector } from '../../connectors/registry.js'
import type { WriteColumn } from '../../connectors/writeProducts.js'

export const writeProductsRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
writeProductsRouter.use(requireAuth({ role: 'admin' }), requireDb)

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'produto'
}

function parseColumns(raw: unknown): WriteColumn[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Defina ao menos uma coluna.')
  return raw.map((c) => {
    const o = c as Record<string, unknown>
    const col = String(o.col ?? '').trim()
    const type = String(o.type ?? 'text')
    if (!col) throw new Error('Coluna sem nome.')
    if (!['text', 'number', 'bool', 'date'].includes(type)) throw new Error(`Tipo inválido: ${type}`)
    return { col, type: type as WriteColumn['type'], required: o.required === true }
  })
}

writeProductsRouter.get('/', async (req, res) => {
  const rows = (await db.query(
    `select p.id, p.slug, p.name, p.connection_id, p.schema_name, p.table_name, p.columns, p.enabled, p.created_at
       from api_write_products p join tenants t on t.id = p.tenant_id
      where t.slug = $1 order by p.created_at desc`,
    [req.user!.tenant],
  )).rows
  res.json({ products: rows })
})

writeProductsRouter.post('/', async (req, res) => {
  try {
    const { name, connectionId, schema, table, columns } = req.body ?? {}
    if (!name || !connectionId || !schema || !table) {
      return res.status(400).json({ error: 'Informe nome, conexão, schema e tabela.' })
    }
    const def = getConnector(String(connectionId))
    if (!def) return res.status(400).json({ error: 'Conexão não encontrada.' })
    if (!def.writable) return res.status(400).json({ error: 'A conexão escolhida não está marcada como GRAVÁVEL.' })
    const cols = parseColumns(columns)

    const tenant = (await db.query('select id from tenants where slug = $1', [req.user!.tenant])).rows[0]
    const base = slugify(String(name))
    const taken = new Set((await db.query('select slug from api_write_products where tenant_id = $1', [tenant.id])).rows.map((r) => r.slug))
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

    const row = (await db.query(
      `insert into api_write_products (tenant_id, slug, name, connection_id, schema_name, table_name, columns, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [tenant.id, slug, String(name), String(connectionId), String(schema), String(table), JSON.stringify(cols), req.user!.email],
    )).rows[0]
    await audit(req, 'write-product.create', { type: 'write_product', id: slug }, { connectionId, table })
    res.status(201).json({ id: row.id, slug })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

writeProductsRouter.patch('/:id', async (req, res) => {
  try {
    const { name, columns, enabled } = req.body ?? {}
    const cols = columns !== undefined ? parseColumns(columns) : null
    const row = (await db.query(
      `update api_write_products p set
         name = coalesce($3, name),
         columns = coalesce($4, columns),
         enabled = coalesce($5, enabled)
       from tenants t
       where p.tenant_id = t.id and t.slug = $1 and p.id = $2 returning p.slug`,
      [req.user!.tenant, req.params.id, name ?? null, cols ? JSON.stringify(cols) : null,
       typeof enabled === 'boolean' ? enabled : null],
    )).rows[0]
    if (!row) return res.status(404).json({ error: 'Produto não encontrado.' })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

writeProductsRouter.delete('/:id', async (req, res) => {
  const row = (await db.query(
    `delete from api_write_products p using tenants t
      where p.tenant_id = t.id and t.slug = $1 and p.id = $2 returning p.slug`,
    [req.user!.tenant, req.params.id],
  )).rows[0]
  if (row) await audit(req, 'write-product.delete', { type: 'write_product', id: String(row.slug) })
  res.json({ ok: true })
})
