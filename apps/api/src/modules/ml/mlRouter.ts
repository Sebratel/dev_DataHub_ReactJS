// Registro de modelos preditivos: definir, treinar, avaliar, promover e
// predizer. Editor cria e treina; promover versão e excluir são de admin —
// promover troca o que responde em produção.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { validateTransformSql } from '../transform/derive.js'
import { runFeatureSql, buildSchema } from './features.js'
import { trainModel, queueDepth, type ModelRow } from './train.js'
import { loadPromoted, scoreBatch, scoreRows } from './predict.js'

export const mlRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const editorOnly = [requireAuth({ role: 'editor' }), requireDb]
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
const fail = (res: Response, e: unknown) => res.status(400).json({ error: (e as Error).message })

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/
const TASKS = new Set(['binary', 'regression'])
const ALGOS = new Set(['logistic', 'linear'])

function toModelRow(r: Record<string, unknown>, tenantSlug: string): ModelRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    tenantSlug,
    task: r.task as ModelRow['task'],
    algorithm: String(r.algorithm),
    featureSql: (r.feature_sql as string | null) ?? null,
    targetColumn: (r.target_column as string | null) ?? null,
    excludedColumns: (r.excluded_columns as string[]) ?? [],
    holdoutPct: Number(r.holdout_pct ?? 20),
    maxRows: Number(r.max_rows ?? 200_000),
    hyperparams: (r.hyperparams as Record<string, unknown>) ?? {},
  }
}

// ── Listagem: modelo + versão em produção + último treino ────────────────
mlRouter.get('/', ...editorOnly, async (req, res) => {
  const rows = (await db.query(
    `select m.*,
            v.version as promoted_version, v.metrics as promoted_metrics,
            v.created_at as promoted_at, v.rows_trained,
            (select count(*) from ml_model_versions x where x.model_id = m.id) as version_count,
            r.status as last_run_status, r.error as last_run_error, r.started_at as last_run_at
       from ml_models m
       join tenants t on t.id = m.tenant_id
       left join ml_model_versions v on v.id = m.promoted_version_id
       left join lateral (
         select status, error, started_at from ml_training_runs
          where model_id = m.id order by started_at desc limit 1
       ) r on true
      where t.slug = $1
      order by m.updated_at desc`,
    [req.user!.tenant],
  )).rows
  res.json({ models: rows, queued: queueDepth() })
})

mlRouter.get('/:slug', ...editorOnly, async (req, res) => {
  const model = (await db.query(
    `select m.* from ml_models m join tenants t on t.id = m.tenant_id
      where t.slug = $1 and m.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!model) return res.status(404).json({ error: 'Modelo não encontrado.' })

  const versions = (await db.query(
    `select id, version, metrics, importances, rows_trained, rows_holdout, trained_ms,
            status, note, created_by, created_at,
            (id = $2) as promoted
       from ml_model_versions where model_id = $1 order by version desc limit 30`,
    [model.id, model.promoted_version_id],
  )).rows
  const runs = (await db.query(
    `select id, status, trigger, rows, error, started_at, finished_at
       from ml_training_runs where model_id = $1 order by started_at desc limit 15`,
    [model.id],
  )).rows
  res.json({ model, versions, runs })
})

// ── Criar / editar ───────────────────────────────────────────────────────
function readInput(body: Record<string, unknown>) {
  const slug = String(body.slug ?? '').trim().toLowerCase()
  if (!SLUG_RE.test(slug)) throw new Error('Identificador inválido: minúsculas, números e hífen (3 a 50 caracteres).')
  const name = String(body.name ?? '').trim()
  if (!name) throw new Error('Informe um nome para o modelo.')
  const task = String(body.task ?? 'binary')
  if (!TASKS.has(task)) throw new Error('Tipo de problema inválido (binary ou regression).')
  const algorithm = String(body.algorithm ?? (task === 'binary' ? 'logistic' : 'linear'))
  if (!ALGOS.has(algorithm)) throw new Error('Algoritmo inválido (logistic ou linear).')
  if (task === 'binary' && algorithm !== 'logistic') throw new Error('Classificação binária usa regressão logística.')
  if (task === 'regression' && algorithm !== 'linear') throw new Error('Alvo contínuo usa regressão linear.')

  const featureSql = String(body.featureSql ?? '').trim()
  if (!featureSql) throw new Error('Escreva o SQL que monta a base de atributos.')
  validateTransformSql(featureSql) // mesmo guard dos derivados

  const targetColumn = String(body.targetColumn ?? '').trim()
  if (!targetColumn) throw new Error('Informe a coluna alvo.')

  const holdoutPct = Number(body.holdoutPct ?? 20)
  if (!Number.isInteger(holdoutPct) || holdoutPct < 5 || holdoutPct > 50) {
    throw new Error('A fatia de validação deve ficar entre 5% e 50%.')
  }
  const maxRows = Number(body.maxRows ?? 200_000)
  if (!Number.isInteger(maxRows) || maxRows < 100 || maxRows > 2_000_000) {
    throw new Error('O teto de linhas deve ficar entre 100 e 2.000.000.')
  }
  const retrain = String(body.retrain ?? 'manual')
  if (!['manual', 'daily', 'weekly'].includes(retrain)) throw new Error('Cadência de retreino inválida.')

  return {
    slug, name, description: String(body.description ?? '').trim(),
    task, algorithm, featureSql, targetColumn,
    excludedColumns: Array.isArray(body.excludedColumns) ? body.excludedColumns.map(String) : [],
    holdoutPct, maxRows, retrain,
    hyperparams: (body.hyperparams as Record<string, unknown>) ?? {},
  }
}

mlRouter.post('/', ...editorOnly, async (req, res) => {
  try {
    const i = readInput(req.body ?? {})
    const row = (await db.query(
      `insert into ml_models
         (tenant_id, slug, name, description, task, algorithm, feature_sql, target_column,
          excluded_columns, holdout_pct, max_rows, retrain, hyperparams, owner_email)
       select t.id, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 from tenants t where t.slug = $1
       returning *`,
      [req.user!.tenant, i.slug, i.name, i.description, i.task, i.algorithm, i.featureSql,
       i.targetColumn, i.excludedColumns, i.holdoutPct, i.maxRows, i.retrain,
       JSON.stringify(i.hyperparams), req.user!.email],
    )).rows[0]
    await audit(req, 'ml.model.create', { type: 'ml_model', id: String(row.id) }, { slug: i.slug })
    res.status(201).json({ model: row })
  } catch (e) { fail(res, e) }
})

mlRouter.put('/:slug', ...editorOnly, async (req, res) => {
  try {
    const i = readInput({ ...req.body, slug: req.body?.slug ?? req.params.slug })
    const row = (await db.query(
      `update ml_models m set
         slug = $3, name = $4, description = $5, task = $6, algorithm = $7,
         feature_sql = $8, target_column = $9, excluded_columns = $10,
         holdout_pct = $11, max_rows = $12, retrain = $13, hyperparams = $14, updated_at = now()
       from tenants t
       where m.tenant_id = t.id and t.slug = $1 and m.slug = $2
       returning m.*`,
      [req.user!.tenant, req.params.slug, i.slug, i.name, i.description, i.task, i.algorithm,
       i.featureSql, i.targetColumn, i.excludedColumns, i.holdoutPct, i.maxRows, i.retrain,
       JSON.stringify(i.hyperparams)],
    )).rows[0]
    if (!row) return res.status(404).json({ error: 'Modelo não encontrado.' })
    await audit(req, 'ml.model.update', { type: 'ml_model', id: String(row.id) }, { slug: i.slug })
    res.json({ model: row })
  } catch (e) { fail(res, e) }
})

mlRouter.delete('/:slug', ...adminOnly, async (req, res) => {
  const row = (await db.query(
    `delete from ml_models m using tenants t
      where m.tenant_id = t.id and t.slug = $1 and m.slug = $2 returning m.id`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Modelo não encontrado.' })
  await audit(req, 'ml.model.delete', { type: 'ml_model', id: String(row.id) })
  res.json({ ok: true })
})

// ── Prévia dos atributos ─────────────────────────────────────────────────
// Antes de treinar: quais colunas viram atributo, quais foram descartadas e por
// quê. Evita descobrir depois de dois minutos de treino que o alvo vazou ou que
// metade das colunas era identificador.
mlRouter.post('/preview', ...editorOnly, async (req, res) => {
  try {
    const sql = String(req.body?.featureSql ?? '')
    const target = String(req.body?.targetColumn ?? '')
    const task = String(req.body?.task ?? 'binary') as 'binary' | 'regression'
    const excluded = Array.isArray(req.body?.excludedColumns) ? req.body.excludedColumns.map(String) : []
    if (!target) throw new Error('Informe a coluna alvo.')

    const rows = await runFeatureSql(req.user!.tenant, sql, 5_000)
    const schema = buildSchema(rows, target, task, excluded)
    res.json({
      sampledRows: rows.length,
      columns: Object.keys(rows[0] ?? {}),
      features: schema.features.map((f) => f.name),
      featureCount: schema.features.length,
      dropped: schema.dropped,
      sample: rows.slice(0, 10),
    })
  } catch (e) { fail(res, e) }
})

// ── Treinar ──────────────────────────────────────────────────────────────
mlRouter.post('/:slug/train', ...editorOnly, async (req, res) => {
  const row = (await db.query(
    `select m.* from ml_models m join tenants t on t.id = m.tenant_id
      where t.slug = $1 and m.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Modelo não encontrado.' })

  try {
    const out = await trainModel(toModelRow(row, req.user!.tenant), req.user!.email)
    await audit(req, 'ml.model.train', { type: 'ml_model', id: String(row.id) },
      { version: out.version, metrics: out.metrics })
    res.json(out)
  } catch (e) { fail(res, e) }
})

// ── Promover versão ──────────────────────────────────────────────────────
// Trocar o que responde em produção. Voltar atrás é promover a anterior — sem
// retreinar, porque a versão é imutável.
mlRouter.post('/:slug/promote/:versionId', ...adminOnly, async (req, res) => {
  const row = (await db.query(
    `update ml_models m set promoted_version_id = v.id, updated_at = now()
       from tenants t, ml_model_versions v
      where m.tenant_id = t.id and t.slug = $1 and m.slug = $2
        and v.id = $3 and v.model_id = m.id
      returning m.id, v.version`,
    [req.user!.tenant, req.params.slug, req.params.versionId],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Modelo ou versão não encontrada.' })
  await audit(req, 'ml.model.promote', { type: 'ml_model', id: String(row.id) }, { version: row.version })
  res.json({ ok: true, version: row.version })
})

// ── Predizer ─────────────────────────────────────────────────────────────
// Em lote sobre o próprio SQL de atributos: "rode o churn na base ativa e me dê
// os N de maior risco".
mlRouter.post('/:slug/predict', ...editorOnly, async (req, res) => {
  try {
    const pm = await loadPromoted(req.user!.tenant, req.params.slug)
    const out = await scoreBatch(pm, {
      limit: Number(req.body?.limit) || 500,
      minScore: req.body?.minScore != null ? Number(req.body.minScore) : undefined,
      keyColumns: Array.isArray(req.body?.keyColumns) ? req.body.keyColumns.map(String) : undefined,
    })
    res.json({ model: pm.slug, version: pm.version, task: pm.task, ...out })
  } catch (e) { fail(res, e) }
})

// Linhas avulsas enviadas pelo chamador (simulação: "e se o plano fosse X?").
mlRouter.post('/:slug/score', ...editorOnly, async (req, res) => {
  try {
    const pm = await loadPromoted(req.user!.tenant, req.params.slug)
    const rows = Array.isArray(req.body?.rows) ? req.body.rows as Record<string, unknown>[] : []
    if (!rows.length) throw new Error('Envie ao menos uma linha em "rows".')
    if (rows.length > 1000) throw new Error('Máximo de 1000 linhas por chamada.')
    res.json({
      model: pm.slug, version: pm.version, task: pm.task,
      predictions: scoreRows(pm, rows).map((s) => s.prediction),
    })
  } catch (e) { fail(res, e) }
})
