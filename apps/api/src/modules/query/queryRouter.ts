// Consulta ao lake — o ÚNICO caminho de leitura de dados para usuários (e,
// no Sprint 6, para a IA). Nunca toca as fontes de produção.
import { Router } from 'express'
import type { QueryDef, QueryResult, FieldType } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth } from '../auth/middleware.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { compileQuery } from './compile.js'
import { duckQuery } from './duck.js'

export const queryRouter = Router()

// Middleware por rota — o router divide o prefixo /datasets com outros.
queryRouter.post('/:slug/query', requireAuth(), async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  const ds = (await db.query(
    `select d.id, d.slug, t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })

  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) {
    return res.status(409).json({
      error: 'Este conjunto ainda não foi sincronizado com o lake. Peça a um administrador para sincronizar.',
    })
  }

  const fields = (await db.query(
    `select key, type, sensitive from dataset_fields
      where dataset_id = $1 and not hidden order by sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean }[]

  // Métricas da biblioteca deste dataset — o compilador resolve {metric: slug}.
  const metrics = (await db.query(
    `select slug, agg, field_key, filters from metrics where dataset_id = $1`,
    [ds.id],
  )).rows.map((m) => ({
    slug: String(m.slug), agg: String(m.agg), fieldKey: String(m.field_key),
    filters: (m.filters ?? []) as import('@datahub/shared').QueryFilter[],
  }))

  const admin = !!req.user?.roles.includes('admin')
  const started = Date.now()
  try {
    const def = (req.body ?? {}) as QueryDef
    const compiled = compileQuery({ ...def, dataset: String(ds.slug) }, fields, {
      admin,
      glob: parquetGlob(dir),
      metrics,
    })
    const result = await duckQuery(compiled.sql, compiled.params)
    let total: number | undefined
    if (compiled.countSql) {
      total = Number((await duckQuery(compiled.countSql, compiled.countParams)).rows[0]?.n ?? 0)
    }
    const typeByKey = new Map(fields.map((f) => [f.key, f.type]))
    const payload: QueryResult = {
      columns: result.columns.map((name) => ({ name, type: typeByKey.get(name) ?? 'text' })),
      rows: result.rows,
      total,
      tookMs: Date.now() - started,
      source: 'lake',
    }
    res.json(payload)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
