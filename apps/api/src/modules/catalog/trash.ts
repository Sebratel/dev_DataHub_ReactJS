// ─────────────────────────────────────────────────────────────────────────
// Lixeira de conjuntos (D-DSP-3; achados DSP-01 e DSP-07 do comitê). Ver a
// migration 042 para o porquê de a definição ir para trash_items.
//
//   DELETE /api/v1/datasets/:id       → manda para a lixeira (datasetsRouter)
//   GET    /api/v1/datasets/:slug/dependents
//   GET    /api/v1/trash               → o que está na lixeira
//   POST   /api/v1/trash/:id/restore   → devolve ao catálogo
//   DELETE /api/v1/trash/:id           → exclui de vez (só admin)
//
// Quem exclui: admin, qualquer conjunto; o DONO, os calculados que criou e
// que não são oficiais. Excluir de vez é só de admin (D-DSP-2). O prazo de 30
// dias roda pelo agendador (purgeExpiredTrash).
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { LAKE_ROOT, listParquet } from '../../core/lake.js'
import { referencedSlugs } from '../transform/derive.js'
import { syncQueueState, enqueueSync, cancelPending } from '../sync/ingest.js'
import { reindexEmbeddings } from '../ai/embeddings.js'

export const TRASH_DAYS = 30

export class TrashError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

// ── Dependentes ──────────────────────────────────────────────────────────
// Tudo que QUEBRA se o conjunto sair do catálogo. Notebooks ficam de fora: a
// célula é rascunho de análise, e travar a limpeza por um SQL esquecido num
// notebook pessoal seria travar a limpeza para sempre.
export type DependentType = 'metric' | 'dashboard' | 'derived' | 'api' | 'model' | 'token'
export interface Dependent { type: DependentType; id: string; name: string }

export async function datasetDependents(tenant: string, ds: { id: string; slug: string }): Promise<Dependent[]> {
  const out: Dependent[] = []
  const add = (type: DependentType, rows: Record<string, unknown>[]) => {
    for (const r of rows) out.push({ type, id: String(r.id), name: String(r.name) })
  }

  add('metric', (await db.query(
    `select id, name from metrics where dataset_id = $1 order by name`, [ds.id],
  )).rows)
  add('dashboard', (await db.query(
    `select distinct d.id, d.name from widgets w join dashboards d on d.id = w.dashboard_id
      where w.dataset_id = $1 order by d.name`, [ds.id],
  )).rows)

  const derivados = (await db.query(
    `select d.id, d.name, d.transform_sql from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind = 'derived' and d.id <> $2 and d.transform_sql is not null
      order by d.name`, [tenant, ds.id],
  )).rows
  add('derived', derivados.filter((r) => referencedSlugs(String(r.transform_sql), [ds.slug]).length > 0))

  add('api', (await db.query(
    `select p.id, p.name from api_products p join tenants t on t.id = p.tenant_id
      where t.slug = $1 and p.kind = 'read' and p.dataset_slug = $2 and p.status <> 'rejected'
      order by p.name`, [tenant, ds.slug],
  )).rows)

  const modelos = (await db.query(
    `select m.id, m.name, m.dataset_slug, m.feature_sql from ml_models m join tenants t on t.id = m.tenant_id
      where t.slug = $1 order by m.name`, [tenant],
  )).rows
  add('model', modelos.filter((m) => m.dataset_slug === ds.slug
    || (m.feature_sql && referencedSlugs(String(m.feature_sql), [ds.slug]).length > 0)))

  // Token com o conjunto no escopo EXPLÍCITO: um sistema de fora lê por ele.
  // Escopo vazio (= todos) não conta — esse token não depende deste conjunto.
  add('token', (await db.query(
    `select c.id, c.name from api_credentials c join tenants t on t.id = c.tenant_id
      where t.slug = $1 and not c.revoked and (c.expires_at is null or c.expires_at > now())
        and $2 = any(c.dataset_slugs)
      order by c.name`, [tenant, ds.slug],
  )).rows)

  return out
}

// ── Enviar para a lixeira ────────────────────────────────────────────────
const relLixeira = (tenant: string, itemId: string) => join('.lixeira', tenant, itemId)

/** true = não há carga deste conjunto rodando (já não havia, ou terminou dentro do prazo). */
async function esperaCargaTerminar(datasetId: string, ms: number): Promise<boolean> {
  const fim = Date.now() + ms
  while (syncQueueState(datasetId).state === 'running') {
    if (Date.now() > fim) return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return true
}

export interface Trashed { trashId: string; expiresAt: string }

export async function trashDataset(req: Request, datasetId: string): Promise<Trashed> {
  const user = req.user!
  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id where t.slug = $1 and d.id = $2`,
    [user.tenant, datasetId],
  )).rows[0]
  if (!ds) throw new TrashError(404, 'Conjunto de dados não encontrado.')

  const admin = user.roles.includes('admin')
  if (!admin) {
    if (ds.kind !== 'derived' || ds.owner_email !== user.email) {
      throw new TrashError(403, 'Só um administrador exclui este conjunto. O dono exclui os calculados que criou.')
    }
    if (ds.official) throw new TrashError(403, 'Conjunto oficial: só um administrador exclui.')
  }

  // Uma carga em andamento escreveria Parquet numa pasta que acabou de sair
  // do lugar — e o conjunto "voltaria" pela metade no diretório antigo. A
  // materialização de um calculado leva segundos (e começa assim que ele é
  // criado), então vale esperar um pouco antes de recusar.
  if (!(await esperaCargaTerminar(String(ds.id), 10_000))) {
    throw new TrashError(409, 'O conjunto está atualizando agora. Pare a carga ou espere terminar, e exclua de novo.')
  }

  const dependents = await datasetDependents(user.tenant, { id: String(ds.id), slug: String(ds.slug) })
  if (dependents.length) {
    throw new TrashError(409,
      `Este conjunto tem ${dependents.length} dependente(s). Remova ou troque cada um antes de excluir.`,
      { dependents })
  }

  // Só ESPERANDO na fila (não começou): sai dela. É o caso de quem cria um
  // calculado, vê que errou e exclui na hora — recusar ali só mandaria a
  // pessoa esperar uma carga que ela não quer. Síncrono: depois desta linha a
  // fila não tem como começá-lo.
  cancelPending([String(ds.id)])
  if (syncQueueState(String(ds.id)).state === 'running') {
    throw new TrashError(409, 'O conjunto começou a atualizar agora. Espere terminar e exclua de novo.')
  }

  // O vetor do catálogo semântico não vai junto: é grande e se recalcula.
  const { embedding: _e, embedding_text: _t, embedded_at: _a, ...dataset } = ds
  const snapshot = {
    dataset,
    fields: (await db.query('select * from dataset_fields where dataset_id = $1 order by sort_order', [ds.id])).rows,
    grants: (await db.query('select * from dataset_grants where dataset_id = $1', [ds.id])).rows,
    views: (await db.query('select * from saved_views where dataset_id = $1', [ds.id])).rows,
  }

  const origem = join(LAKE_ROOT, user.tenant, String(ds.slug))
  const client = await db.connect()
  let movidoPara: string | null = null
  try {
    await client.query('begin')
    const item = (await client.query(
      `insert into trash_items (tenant_id, kind, original_id, slug, name, owner_email, snapshot, deleted_by)
       values ($1, 'dataset', $2, $3, $4, $5, $6, $7) returning id, deleted_at`,
      [ds.tenant_id, ds.id, ds.slug, ds.name, ds.owner_email, JSON.stringify(snapshot), user.email],
    )).rows[0]
    await client.query('delete from datasets where id = $1', [ds.id])

    // Os Parquet saem do lugar do slug: um conjunto novo com o mesmo nome não
    // pode nascer enxergando estes dados (ver removeDatasetDir em lake.ts).
    if (existsSync(origem)) {
      const rel = relLixeira(user.tenant, String(item.id))
      const destino = join(LAKE_ROOT, rel)
      mkdirSync(dirname(destino), { recursive: true })
      renameSync(origem, destino)
      movidoPara = destino
      await client.query('update trash_items set lake_path = $2 where id = $1', [item.id, rel])
    }
    await client.query('commit')

    const expiresAt = new Date(new Date(item.deleted_at).getTime() + TRASH_DAYS * 86_400_000).toISOString()
    await audit(req, 'datasets.trash', { type: 'dataset', id: String(ds.slug) },
      { trashId: String(item.id), kind: ds.kind, comDados: !!movidoPara, expiresAt })
    return { trashId: String(item.id), expiresAt }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    if (movidoPara) {
      try { renameSync(movidoPara, origem) } catch { /* o erro original é o que importa */ }
    }
    throw e
  } finally {
    client.release()
  }
}

// ── Restaurar ────────────────────────────────────────────────────────────
// A definição volta como estava, com o MESMO id: o histórico de uso e a
// auditoria continuam apontando para ela. As colunas são as de HOJE — uma
// migration feita enquanto o item esperava não quebra a volta.
const colunasCache = new Map<string, Map<string, string>>()
async function colunasDe(table: string): Promise<Map<string, string>> {
  let c = colunasCache.get(table)
  if (!c) {
    c = new Map((await db.query(
      `select column_name, data_type from information_schema.columns
        where table_schema = current_schema() and table_name = $1`, [table],
    )).rows.map((r) => [String(r.column_name), String(r.data_type)]))
    colunasCache.set(table, c)
  }
  return c
}

type Exec = { query: (sql: string, params?: unknown[]) => Promise<unknown> }

async function insereLinha(client: Exec, table: string, row: Record<string, unknown>): Promise<void> {
  const tipos = await colunasDe(table)
  const cols: string[] = []
  const vals: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(row)) {
    const tipo = tipos.get(k)
    if (!tipo || tipo === 'USER-DEFINED') continue // coluna que não existe mais, ou vetor
    params.push(tipo === 'jsonb' || tipo === 'json' ? (v === null ? null : JSON.stringify(v)) : v)
    cols.push(`"${k}"`)
    vals.push(tipo === 'jsonb' || tipo === 'json' ? `$${params.length}::jsonb` : `$${params.length}`)
  }
  await client.query(`insert into ${table} (${cols.join(', ')}) values (${vals.join(', ')})`, params)
}

interface Snapshot {
  dataset: Record<string, unknown>
  fields: Record<string, unknown>[]
  grants: Record<string, unknown>[]
  views: Record<string, unknown>[]
}

export async function restoreTrashItem(req: Request, itemId: string): Promise<{ slug: string; renamed: boolean }> {
  const user = req.user!
  const item = (await db.query(
    `select i.* from trash_items i join tenants t on t.id = i.tenant_id
      where t.slug = $1 and i.id = $2 and i.kind = 'dataset'`, [user.tenant, itemId],
  )).rows[0]
  if (!item) throw new TrashError(404, 'Item não encontrado na lixeira.')
  if (item.restored_at) throw new TrashError(409, `Já foi restaurado como "${item.restored_slug}".`)
  if (item.purged_at) throw new TrashError(410, 'Este item já foi excluído de vez; não há o que restaurar.')
  const admin = user.roles.includes('admin')
  if (!admin && item.deleted_by !== user.email && item.owner_email !== user.email) {
    throw new TrashError(403, 'Só quem excluiu, o dono ou um administrador restaura.')
  }

  const snap = item.snapshot as Snapshot
  const d: Record<string, unknown> = { ...snap.dataset }

  // O slug pode ter sido reaproveitado por um conjunto novo enquanto este
  // esperava na lixeira. Volta com sufixo, como a publicação faz.
  const ocupados = new Set((await db.query(
    'select slug from datasets where tenant_id = $1', [item.tenant_id],
  )).rows.map((r) => String(r.slug)))
  const original = String(d.slug)
  let slug = original
  for (let i = 2; ocupados.has(slug); i++) slug = `${original}-${i}`
  d.slug = slug
  if (d.kind === 'derived') d.object_name = slug // calculado usa o slug como "objeto"

  // Agendamento apagado nesse meio-tempo: volta para a diária, que é o padrão.
  if (d.schedule_id) {
    const existe = (await db.query('select 1 from sync_schedules where id = $1', [d.schedule_id])).rows[0]
    if (!existe) { d.schedule_id = null; d.sync_cadence = 'daily' }
  }

  const times = new Set((await db.query(
    'select id from teams where tenant_id = $1', [item.tenant_id],
  )).rows.map((r) => String(r.id)))

  const destino = join(LAKE_ROOT, user.tenant, slug)
  const guardado = item.lake_path ? join(LAKE_ROOT, String(item.lake_path)) : null
  const client = await db.connect()
  let voltou = false
  try {
    await client.query('begin')
    await insereLinha(client, 'datasets', d)
    for (const f of snap.fields) await insereLinha(client, 'dataset_fields', f)
    for (const g of snap.grants) {
      if (g.team_id && !times.has(String(g.team_id))) continue // time excluído: a concessão não tem a quem voltar
      await insereLinha(client, 'dataset_grants', g)
    }
    for (const v of snap.views) await insereLinha(client, 'saved_views', v)
    await client.query(
      `update trash_items set restored_at = now(), restored_by = $2, restored_slug = $3 where id = $1`,
      [item.id, user.email, slug],
    )
    if (guardado && existsSync(guardado)) {
      // Uma leitura do slug pode ter criado a pasta vazia nesse meio-tempo
      // (datasetDir cria ao consultar). Vazia, ela sai; com dado, é de outro.
      if (existsSync(destino) && readdirSync(destino).length === 0) rmSync(destino, { recursive: true, force: true })
      mkdirSync(dirname(destino), { recursive: true })
      renameSync(guardado, destino)
      voltou = true
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    if (voltou && guardado) {
      try { renameSync(destino, guardado) } catch { /* o erro original é o que importa */ }
    }
    const msg = (e as Error).message
    if (msg.includes('datasets_tenant_id_connection_id_schema_name_object_name_key')) {
      throw new TrashError(409,
        'A mesma tabela da fonte foi publicada de novo depois da exclusão. Exclua o conjunto novo para restaurar este, ou fique com o novo.')
    }
    if (msg.includes('datasets_pkey')) throw new TrashError(409, 'Este conjunto já está no catálogo.')
    throw e
  } finally {
    client.release()
  }

  await audit(req, 'datasets.restore', { type: 'dataset', id: slug },
    { trashId: String(item.id), ...(slug !== original ? { slugOriginal: original } : {}), comDados: voltou })
  void reindexEmbeddings(String(d.id)).catch(() => { /* o reindex periódico pega depois */ })
  // Sem Parquet (não havia, ou foram excluídos de vez), o conjunto volta vazio:
  // a carga refaz a partir da fonte, ou o calculado materializa de novo.
  if (!listParquet(destino).length) void enqueueSync(String(d.id))
  return { slug, renamed: slug !== original }
}

// ── Excluir de vez ───────────────────────────────────────────────────────
// Apaga os Parquet e marca o item. A linha da lixeira fica, como registro.
async function purgeItem(itemId: string): Promise<boolean> {
  const item = (await db.query(
    `select id, lake_path from trash_items where id = $1 and restored_at is null and purged_at is null`, [itemId],
  )).rows[0]
  if (!item) return false
  if (item.lake_path) {
    try {
      rmSync(join(LAKE_ROOT, String(item.lake_path)), { recursive: true, force: true })
    } catch (e) {
      console.warn(`[lixeira] não foi possível apagar ${item.lake_path}: ${(e as Error).message}`)
    }
  }
  return true
}

export async function purgeTrashItem(req: Request, itemId: string): Promise<void> {
  const item = (await db.query(
    `select i.* from trash_items i join tenants t on t.id = i.tenant_id where t.slug = $1 and i.id = $2`,
    [req.user!.tenant, itemId],
  )).rows[0]
  if (!item) throw new TrashError(404, 'Item não encontrado na lixeira.')
  if (item.restored_at) throw new TrashError(409, 'Este item foi restaurado; exclua o conjunto de novo, se for o caso.')
  if (item.purged_at) return
  await purgeItem(String(item.id))
  await db.query(`update trash_items set purged_at = now(), purged_by = $2 where id = $1`, [item.id, req.user!.email])
  await audit(req, 'datasets.purge', { type: 'dataset', id: String(item.slug) }, { trashId: String(item.id) })
}

// Prazo de 30 dias. Roda na hora cheia pelo agendador; idempotente.
export async function purgeExpiredTrash(): Promise<number> {
  const vencidos = (await db.query(
    `select id, tenant_id, slug from trash_items
      where restored_at is null and purged_at is null
        and deleted_at < now() - make_interval(days => $1)`, [TRASH_DAYS],
  )).rows
  for (const v of vencidos) {
    if (!(await purgeItem(String(v.id)))) continue
    await db.query(`update trash_items set purged_at = now(), purged_by = 'sistema' where id = $1`, [v.id])
    await db.query(
      `insert into audit_logs (tenant_id, user_email, action, resource_type, resource_id, detail)
       values ($1, 'sistema', 'datasets.purge', 'dataset', $2, $3)`,
      [v.tenant_id, v.slug, JSON.stringify({ trashId: String(v.id), motivo: `${TRASH_DAYS} dias na lixeira` })],
    )
  }
  if (vencidos.length) console.log(`[lixeira] ${vencidos.length} item(ns) com ${TRASH_DAYS} dias excluído(s) de vez.`)
  return vencidos.length
}

export function sendTrashError(res: Response, e: unknown): void {
  if (e instanceof TrashError) {
    res.status(e.status).json({ error: e.message, ...e.extra })
    return
  }
  res.status(500).json({ error: (e as Error).message })
}

// ── Rotas da lixeira ─────────────────────────────────────────────────────
export const trashRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}

// Admin vê a lixeira inteira; os demais, o que excluíram ou o que era deles.
trashRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const admin = req.user!.roles.includes('admin')
  const rows = (await db.query(
    `select i.id, i.kind, i.slug, i.name, i.owner_email, i.deleted_by, i.deleted_at, i.lake_path,
            i.snapshot->'dataset'->>'kind' as dataset_kind
       from trash_items i join tenants t on t.id = i.tenant_id
      where t.slug = $1 and i.restored_at is null and i.purged_at is null
        and ($2 or i.deleted_by = $3 or i.owner_email = $3)
      order by i.deleted_at desc`,
    [req.user!.tenant, admin, req.user!.email],
  )).rows
  res.json({
    days: TRASH_DAYS,
    items: rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      datasetKind: r.dataset_kind === 'derived' ? 'derived' : 'source',
      slug: String(r.slug),
      name: String(r.name),
      ownerEmail: (r.owner_email as string | null) ?? null,
      deletedBy: String(r.deleted_by),
      deletedAt: new Date(r.deleted_at).toISOString(),
      expiresAt: new Date(new Date(r.deleted_at).getTime() + TRASH_DAYS * 86_400_000).toISOString(),
      hasData: !!r.lake_path,
    })),
  })
})

trashRouter.post('/:id/restore', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  try {
    res.json(await restoreTrashItem(req, req.params.id))
  } catch (e) { sendTrashError(res, e) }
})

trashRouter.delete('/:id', requireAuth({ role: 'admin' }), requireDb, async (req, res) => {
  try {
    await purgeTrashItem(req, req.params.id)
    res.json({ ok: true })
  } catch (e) { sendTrashError(res, e) }
})
