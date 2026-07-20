// ─────────────────────────────────────────────────────────────────────────
// Catálogo de Conjuntos de Dados.
//   Usuário:  GET /            lista publicados (sem nomes físicos)
//             GET /:slug       detalhe com campos visíveis
//   Admin:    POST /           publica tabela descoberta como dataset
//             PATCH /:id       edita nome/descrição/tags
//             PATCH /:id/fields/:fieldId  label/descrição/oculto/sensível
//             GET /:slug/preview  amostra ao vivo (LIMIT 50, sensíveis mascarados)
//             DELETE /:id      despublica
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { DatasetSummary, DatasetDetail, AdminDatasetField, FieldType } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { querySource, discoverColumns } from '../../connectors/pools.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { accessibleDatasetIds, canQuery } from '../../core/access.js'

export const datasetsRouter = Router()

datasetsRouter.use(requireAuth(), (req, res, next) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  next()
})

function isAdmin(req: { user?: { roles: string[] } }): boolean {
  return !!req.user?.roles.includes('admin')
}

// information_schema.data_type → tipo amigável do catálogo.
function mapType(dataType: string): FieldType {
  const dt = dataType.toLowerCase()
  if (/int|numeric|decimal|double|real|float|money/.test(dt)) return 'number'
  if (/bool/.test(dt)) return 'bool'
  if (/date|time/.test(dt)) return 'date'
  if (/json/.test(dt)) return 'json'
  return 'text'
}

function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'dataset'
}

// "Cliente ID" a partir de client_id — label inicial legível para a coluna.
function labelize(column: string): string {
  return column.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const DATASET_COLUMNS = `
  d.id, d.slug, d.name, d.description, d.tags, d.owner_email,
  d.row_count, d.last_sync_at, d.updated_at, d.kind, d.transform_sql,
  d.connection_id, d.schema_name, d.object_name,
  d.sync_mode, d.incremental_key,
  (select count(*) from dataset_fields f where f.dataset_id = d.id and not f.hidden) as field_count`

function toSummary(row: Record<string, unknown>, admin: boolean): DatasetSummary {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ''),
    kind: (row.kind === 'derived' ? 'derived' : 'source'),
    tags: (row.tags as string[]) ?? [],
    ownerEmail: (row.owner_email as string) ?? null,
    fieldCount: Number(row.field_count) || 0,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    updatedAt: String(row.updated_at),
    // Nomes físicos só para admin — o usuário nunca vê schema/tabela.
    ...(admin ? {
      source: {
        connectionId: String(row.connection_id),
        schema: String(row.schema_name),
        table: String(row.object_name),
      },
      sync: {
        mode: String(row.sync_mode) as 'live' | 'snapshot' | 'incremental',
        incrementalKey: (row.incremental_key as string) ?? null,
      },
    } : {}),
  }
}

// ─── Leitura (qualquer usuário do tenant) ──────────────────────
datasetsRouter.get('/', async (req, res) => {
  const rows = (await db.query(
    `select ${DATASET_COLUMNS} from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 order by d.name`,
    [req.user!.tenant],
  )).rows
  // Escopo de acesso: o usuário só vê os conjuntos a que tem acesso.
  const allowed = await accessibleDatasetIds(req.user!)
  const visible = rows.filter((r) => allowed.has(String(r.id)))
  res.json({ datasets: visible.map((r) => toSummary(r, isAdmin(req))) })
})

datasetsRouter.get('/:slug', async (req, res) => {
  const row = (await db.query(
    `select ${DATASET_COLUMNS} from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })

  // Acesso ao detalhe: mesma regra da consulta.
  if (!(await canQuery(req.user!, String(row.id)))) {
    return res.status(403).json({ error: 'Você não tem acesso a este conjunto de dados.' })
  }

  const admin = isAdmin(req)
  // Campos ocultos só vão para admins (para poderem reexibi-los na edição).
  const fields = (await db.query(
    `select id, key, label, description, type, hidden, sensitive, sort_order
       from dataset_fields where dataset_id = $1 ${admin ? '' : 'and not hidden'}
      order by sort_order, key`,
    [row.id],
  )).rows.map((f): AdminDatasetField => ({
    id: String(f.id), key: String(f.key), label: String(f.label),
    description: (f.description as string) ?? null, type: f.type as FieldType,
    hidden: !!f.hidden, sensitive: !!f.sensitive, sortOrder: Number(f.sort_order),
  }))

  // SQL do derivado: editores/admins veem (para poder editar).
  const canEditSql = req.user!.roles.some((r) => r === 'admin' || r === 'editor')
  const detail: DatasetDetail = {
    ...toSummary(row, admin),
    fields,
    ...(row.kind === 'derived' && canEditSql ? { transformSql: (row.transform_sql as string) ?? null } : {}),
  }
  res.json({ dataset: detail })
})

// ─── Administração ─────────────────────────────────────────────
// Publica uma tabela descoberta como Conjunto de Dados, importando os campos.
datasetsRouter.post('/', requireAuth({ role: 'admin' }), async (req, res) => {
  const { connectionId, schema, table, name, description } = req.body ?? {}
  if (!connectionId || !schema || !table) {
    return res.status(400).json({ error: 'connectionId, schema e table são obrigatórios.' })
  }
  if (!getConnector(String(connectionId))) {
    return res.status(400).json({ error: `Fonte desconhecida: ${connectionId}` })
  }

  let columns
  try {
    columns = await discoverColumns(String(connectionId), String(schema), String(table))
  } catch (e) {
    return res.status(400).json({ error: `Falha ao ler colunas da fonte: ${(e as Error).message}` })
  }
  if (!columns.length) return res.status(400).json({ error: 'Tabela sem colunas visíveis (ou inexistente).' })

  const displayName = String(name || labelize(String(table)))
  const client = await db.connect()
  try {
    await client.query('begin')
    const tenant = (await client.query('select id from tenants where slug = $1', [req.user!.tenant])).rows[0]

    // Slug único no tenant: acrescenta -2, -3… se já existir.
    const base = slugify(displayName)
    const taken = new Set(
      (await client.query('select slug from datasets where tenant_id = $1', [tenant.id])).rows.map((r) => r.slug),
    )
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

    const ds = (await client.query(
      `insert into datasets (tenant_id, connection_id, schema_name, object_name, slug, name, description, owner_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [tenant.id, connectionId, schema, table, slug, displayName, String(description || ''), req.user!.email],
    )).rows[0]

    for (const [i, col] of columns.entries()) {
      await client.query(
        `insert into dataset_fields (dataset_id, source_column, key, label, type, sort_order)
         values ($1, $2, $3, $4, $5, $6)`,
        [ds.id, col.name, col.name, labelize(col.name), mapType(col.dataType), i],
      )
    }
    await client.query('commit')
    await audit(req, 'datasets.publish', { type: 'dataset', id: slug }, { connectionId, schema, table })
    res.status(201).json({ id: ds.id, slug })
  } catch (e) {
    await client.query('rollback')
    const msg = (e as Error).message
    if (msg.includes('datasets_tenant_id_connection_id_schema_name_object_name_key')) {
      return res.status(409).json({ error: 'Esta tabela já foi publicada como conjunto de dados.' })
    }
    res.status(500).json({ error: msg })
  } finally {
    client.release()
  }
})

datasetsRouter.patch('/:id', requireAuth({ role: 'admin' }), async (req, res) => {
  const { name, description, tags } = req.body ?? {}
  const row = (await db.query(
    `update datasets set
       name = coalesce($2, name),
       description = coalesce($3, description),
       tags = coalesce($4, tags),
       updated_at = now()
     where id = $1 returning slug`,
    [req.params.id, name ?? null, description ?? null, Array.isArray(tags) ? tags : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  await audit(req, 'datasets.update', { type: 'dataset', id: row.slug })
  res.json({ ok: true })
})

datasetsRouter.patch('/:id/fields/:fieldId', requireAuth({ role: 'admin' }), async (req, res) => {
  const { label, description, hidden, sensitive } = req.body ?? {}
  const row = (await db.query(
    `update dataset_fields set
       label = coalesce($3, label),
       description = coalesce($4, description),
       hidden = coalesce($5, hidden),
       sensitive = coalesce($6, sensitive)
     where id = $2 and dataset_id = $1 returning key`,
    [req.params.id, req.params.fieldId, label ?? null, description ?? null,
     typeof hidden === 'boolean' ? hidden : null, typeof sensitive === 'boolean' ? sensitive : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Campo não encontrado.' })
  await audit(req, 'datasets.field.update', { type: 'dataset', id: req.params.id }, { field: row.key, hidden, sensitive })
  res.json({ ok: true })
})

datasetsRouter.delete('/:id', requireAuth({ role: 'admin' }), async (req, res) => {
  const row = (await db.query('delete from datasets where id = $1 returning slug', [req.params.id])).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  await audit(req, 'datasets.unpublish', { type: 'dataset', id: row.slug })
  res.json({ ok: true })
})

// Amostra AO VIVO da fonte (admin, LIMIT 50) — validação na publicação.
// Campos ocultos ficam fora do SELECT; sensíveis voltam mascarados.
datasetsRouter.get('/:slug/preview', requireAuth({ role: 'admin' }), async (req, res) => {
  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })

  const fields = (await db.query(
    `select source_column, key, sensitive from dataset_fields
      where dataset_id = $1 and not hidden order by sort_order`,
    [ds.id],
  )).rows
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo visível para pré-visualizar.' })

  const def = getConnector(String(ds.connection_id))
  if (!def) return res.status(400).json({ error: `Fonte desconhecida: ${ds.connection_id}` })
  const q = def.kind === 'mysql'
    ? (s: string) => '`' + s.replace(/`/g, '') + '`'
    : (s: string) => '"' + s.replace(/"/g, '') + '"'
  const cols = fields.map((f) => `${q(f.source_column)} as ${q(f.key)}`).join(', ')
  const sql = `select ${cols} from ${q(ds.schema_name)}.${q(ds.object_name)} limit 50`

  try {
    const { rows } = await querySource(String(ds.connection_id), sql)
    const sensitiveKeys = new Set(fields.filter((f) => f.sensitive).map((f) => f.key as string))
    for (const row of rows) {
      for (const key of sensitiveKeys) if (row[key] != null) row[key] = '•••'
    }
    await audit(req, 'datasets.preview', { type: 'dataset', id: ds.slug })
    res.json({ rows, limited: 50 })
  } catch (e) {
    res.status(400).json({ error: `Falha ao consultar a fonte: ${(e as Error).message}` })
  }
})
