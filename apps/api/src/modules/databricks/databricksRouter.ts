// Publicação no Databricks: configurar por conjunto, ver o histórico de envios
// e disparar um envio à mão.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import type { DatabricksRun } from '@datahub/shared'
import { requireAuth, audit, MASTER_ONLY_MESSAGE } from '../auth/middleware.js'
import { config } from '../../core/config.js'
import { publicarDataset, camadaDe, slugDeTabela } from './publish.js'

export const databricksRouter = Router()
export const databricksAdminRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

// Ligar a publicação é do admin MASTER, e por um motivo diferente do que vale
// para as fontes: aqui o dado SAI da rede interna. Não é carga num banco de
// produção — é um conjunto inteiro atravessando a internet para um workspace de
// terceiro. A seção 8 do spec ainda exige conferir dado pessoal antes de
// habilitar, e essa conferência precisa de um dono.
function requireMaster(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.master) { res.status(403).json({ error: MASTER_ONLY_MESSAGE }); return }
  next()
}

const adminOnly = [requireAuth({ role: 'admin' }), requireDb]
const masterOnly = [...adminOnly, requireMaster]

const MODOS = new Set(['SNAPSHOT', 'INCREMENTAL'])
const CAMADAS = new Set(['bronze', 'prata', 'ouro'])

// Estado geral da integração — o que a tela precisa para explicar por que um
// envio não saiu. O token NUNCA vai no corpo: só se ele existe.
databricksAdminRouter.get('/status', ...adminOnly, async (_req, res) => {
  const { rows } = await db.query(
    `select d.slug, d.databricks_mode, d.databricks_layer, d.kind,
            r.status, r.row_count, r.source_parts, r.attempts,
            r.error_message, r.started_at, r.finished_at
       from datasets d
       left join lateral (
         select * from databricks_sync_runs x
          where x.dataset_slug = d.slug order by x.started_at desc limit 1
       ) r on true
      where d.databricks_enabled = true
      order by d.slug`,
  )
  res.json({
    enabled: config.databricks.enabled,
    host: config.databricks.host || null,
    volumePath: config.databricks.volumePath,
    hasCredential: Boolean(config.databricks.token || config.databricks.clientId),
    authMode: config.databricks.token ? 'PAT' : config.databricks.clientId ? 'OAuth M2M' : null,
    datasets: rows.map((r) => ({
      slug: r.slug,
      mode: r.databricks_mode,
      layer: camadaDe(String(r.kind), r.databricks_layer as string | null),
      table: slugDeTabela(String(r.slug)),
      lastRun: r.status
        ? {
            status: r.status, rowCount: r.row_count, sourceParts: r.source_parts,
            attempts: r.attempts, error: r.error_message,
            startedAt: r.started_at, finishedAt: r.finished_at,
          }
        : null,
    })),
  })
})

// Liga/desliga e configura o conjunto. Campo ausente no corpo não é alterado.
databricksRouter.patch('/:id/databricks', ...masterOnly, async (req, res) => {
  const { enabled, mode, layer } = req.body ?? {}
  if (mode != null && !MODOS.has(String(mode))) {
    return res.status(400).json({ error: 'Modo deve ser SNAPSHOT ou INCREMENTAL.' })
  }
  if (layer != null && layer !== '' && !CAMADAS.has(String(layer))) {
    return res.status(400).json({ error: 'Camada deve ser bronze, prata ou ouro.' })
  }
  const row = (await db.query(
    `update datasets set
       databricks_enabled = coalesce($2, databricks_enabled),
       databricks_mode = coalesce($3, databricks_mode),
       -- String vazia volta ao padrão (camada derivada do kind); nulo não mexe.
       databricks_layer = case when $4 = '' then null else coalesce($4, databricks_layer) end,
       updated_at = now()
     where id = $1 returning slug, databricks_enabled, databricks_mode, databricks_layer`,
    [req.params.id, typeof enabled === 'boolean' ? enabled : null,
     mode != null ? String(mode) : null, layer != null ? String(layer) : null],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  await audit(req, 'databricks.config', { type: 'dataset', id: row.slug }, {
    enabled: row.databricks_enabled, mode: row.databricks_mode, layer: row.databricks_layer,
  })
  res.json({ ok: true })
})

databricksRouter.get('/:id/databricks-runs', ...adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select id, status, mode, source_parts, row_count, file_size_bytes, file_path,
            attempts, error_message, started_at, finished_at
       from databricks_sync_runs where dataset_id = $1
      order by started_at desc limit 20`,
    [req.params.id],
  )).rows
  const runs: DatabricksRun[] = rows.map((r) => ({
    id: String(r.id),
    status: r.status as DatabricksRun['status'],
    mode: String(r.mode),
    sourceParts: r.source_parts === null ? null : Number(r.source_parts),
    rowCount: r.row_count === null ? null : Number(r.row_count),
    fileSizeBytes: r.file_size_bytes === null ? null : Number(r.file_size_bytes),
    filePath: (r.file_path as string) ?? null,
    attempts: Number(r.attempts ?? 0),
    errorMessage: (r.error_message as string) ?? null,
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
  }))
  res.json({ runs })
})

// Envio à mão. Existe para o piloto: o primeiro envio real é um conjunto
// pequeno, disparado de propósito, com o resto desligado — esperar o ciclo das
// horas cheias para descobrir que a credencial está errada é tempo jogado fora.
databricksRouter.post('/:id/databricks-publish', ...adminOnly, async (req, res) => {
  const ds = (await db.query('select slug from datasets where id = $1', [req.params.id])).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  const r = await publicarDataset(req.params.id, new Date())
  await audit(req, 'databricks.publish', { type: 'dataset', id: ds.slug }, { status: r.status })
  // SKIPPED não é erro, mas também não é sucesso: 409 deixa a tela dizer "não
  // saiu, e o motivo é este" em vez de mostrar um OK que não aconteceu.
  const http = r.status === 'SUCCESS' ? 200 : r.status === 'SKIPPED' ? 409 : 502
  res.status(http).json(r)
})
