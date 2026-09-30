// Rotas de Conjuntos Derivados (montadas em /api/v1/datasets, ANTES do router
// genérico do catálogo). Editores criam/editam os próprios; admin edita todos.
//   POST  /derived            cria (valida + materializa em background)
//   POST  /derived/preview    amostra do SQL (LIMIT 50) sem criar nada
//   PATCH /derived/:id        nome/descrição/SQL (SQL novo → re-materializa)
//   POST  /derived/:id/materialize  atualiza agora (fila sequencial)
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { enqueueSync } from '../sync/ingest.js'
import {
  validateTransformSql, previewDerived, assertNoDerivedCycle, assertReferencesAllowed,
  auditDerivedCadence, referencedSlugs, type CadenceRow,
} from './derive.js'
import type { AccessUser } from '../../core/access.js'

export const transformRouter = Router()

// 'schedule' fica de fora de proposito: so a rota /schedules/:id/assign
// pode gravar essa cadencia, porque ela precisa vir emparelhada com
// schedule_id (a constraint do banco exige os dois juntos) -- aceitar
// 'schedule' aqui deixaria a tela mandar um sem o outro e estourar um
// erro de constraint cru em vez de uma mensagem clara.
const CADENCES = new Set(['daily', 'hourly', 'manual', 'cascade'])

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const editorOnly = [requireAuth({ role: 'editor' }), requireDb]

function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'derivado'
}

// Valida o SQL de ponta a ponta: guard + denylist + permissão + execução real
// (LIMIT 50). Devolve o erro amigável do DuckDB quando o SQL não compila.
//
// O `user` não é opcional aqui de propósito: é ele que impede alguém de
// alcançar um conjunto restrito só escrevendo o slug no SQL.
async function tryPreview(user: AccessUser, sql: string) {
  validateTransformSql(sql)
  await assertReferencesAllowed(user.tenant, sql, user)
  return previewDerived(user.tenant, sql, user)
}

transformRouter.post('/derived/preview', ...editorOnly, async (req, res) => {
  const { sql } = req.body ?? {}
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'Informe o SQL.' })
  try {
    res.json(await tryPreview(req.user!, sql))
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ── Auditoria de cadência dos calculados ─────────────────────────────────
// Lê o catálogo inteiro do tenant (fontes E derivados: as fontes entram como
// candidatas a serem citadas) e devolve o parecer por derivado.
//
// Fica ANTES de '/derived/:id' de propósito — 'cadence-audit' casaria com o
// parâmetro se viesse depois.
async function cadenceRows(tenantSlug: string) {
  return (await db.query(
    `select d.id, d.slug, d.name, d.kind, d.sync_cadence, d.transform_sql, d.owner_email
       from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 order by d.name`,
    [tenantSlug],
  )).rows
}

const toCadenceRow = (r: Record<string, unknown>): CadenceRow => ({
  id: String(r.id), slug: String(r.slug), name: String(r.name),
  kind: String(r.kind), cadence: String(r.sync_cadence ?? 'daily'),
  transformSql: (r.transform_sql as string | null) ?? null,
})

transformRouter.get('/derived/cadence-audit', ...editorOnly, async (req, res) => {
  const items = auditDerivedCadence((await cadenceRows(req.user!.tenant)).map(toCadenceRow))
  res.json({ items, eligible: items.filter((i) => i.eligible).length })
})

// Troca para 'cascade' os calculados marcados. A lista do cliente é só um
// FILTRO: a elegibilidade é recalculada aqui, sobre o catálogo atual. Quem
// não é admin só alcança os próprios derivados, mesma regra do PATCH.
transformRouter.post('/derived/cadence-audit', ...editorOnly, async (req, res) => {
  const { ids } = req.body ?? {}
  const pedido = Array.isArray(ids) ? new Set(ids.map(String)) : null

  const rows = await cadenceRows(req.user!.tenant)
  const dono = new Map(rows.map((r) => [String(r.id), (r.owner_email as string | null) ?? null]))
  const admin = req.user!.roles.includes('admin')

  const alvo = auditDerivedCadence(rows.map(toCadenceRow))
    .filter((i) => i.eligible)
    .filter((i) => !pedido || pedido.has(i.id))
    .filter((i) => admin || dono.get(i.id) === req.user!.email)

  for (const i of alvo) {
    // schedule_id cai junto: a constraint datasets_schedule_pairing_check
    // exige que 'schedule' e schedule_id andem sempre emparelhados, e sair
    // para 'cascade' desfaz esse par. Aqui os elegíveis são todos de relógio
    // fixo (já com schedule_id nulo), mas deixar implícito é como a mesma
    // falha derrubou 100% de um lote na padronização das fontes.
    await db.query(
      `update datasets set sync_cadence = 'cascade', schedule_id = null, updated_at = now()
        where id = $1`,
      [i.id],
    )
  }
  await audit(req, 'datasets.derived.cadence.cascade', { type: 'dataset', id: 'lote' },
    { switched: alvo.map((i) => i.slug) })
  res.json({ switched: alvo.length, names: alvo.map((i) => i.name) })
})

transformRouter.post('/derived', ...editorOnly, async (req, res) => {
  const { name, description, sql, syncCadence } = req.body ?? {}
  if (!name || !sql) return res.status(400).json({ error: 'name e sql são obrigatórios.' })
  if (syncCadence != null && !CADENCES.has(String(syncCadence))) {
    return res.status(400).json({ error: 'Cadência inválida.' })
  }
  try {
    await tryPreview(req.user!, String(sql))
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message })
  }

  const tenant = (await db.query('select id from tenants where slug = $1', [req.user!.tenant])).rows[0]
  const taken = new Set(
    (await db.query('select slug from datasets where tenant_id = $1', [tenant.id])).rows.map((r) => r.slug),
  )
  const base = slugify(String(name))
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

  // Cadência padrão: CASCATA, não diária. Um derivado não lê fonte nenhuma —
  // ele recalcula um SQL sobre o lake —, então relógio próprio nele só duplica
  // (mal) a frequência de quem ele cita: roda antes da fonte e refaz o
  // resultado anterior, ou roda depois e serve dado velho até a hora cheia.
  //
  // A exceção: SQL que não cita conjunto nenhum. Em cascata, nada o
  // dispararia, e ele pararia no tempo em silêncio — esse cai para diária.
  const citaAlguem = referencedSlugs(String(sql), [...taken] as string[]).length > 0
  const cadence = syncCadence ? String(syncCadence) : (citaAlguem ? 'cascade' : 'daily')

  const ds = (await db.query(
    `insert into datasets (tenant_id, kind, transform_sql, connection_id, schema_name, object_name,
                           slug, name, description, sync_mode, sync_cadence, owner_email)
     values ($1, 'derived', $2, 'lake', 'derived', $3, $3, $4, $5, 'snapshot', $6, $7)
     returning id`,
    [tenant.id, String(sql), slug, String(name).trim(), String(description || ''),
     cadence, req.user!.email],
  )).rows[0]

  void enqueueSync(String(ds.id)) // primeira materialização em background
  await audit(req, 'datasets.derived.create', { type: 'dataset', id: slug })
  res.status(201).json({ id: ds.id, slug })
})

// Busca o derivado no tenant e checa permissão (admin ou dono).
async function findEditable(req: Request): Promise<{ id: string; slug: string } | null> {
  const row = (await db.query(
    `select d.id, d.slug, d.owner_email from datasets d
      join tenants t on t.id = d.tenant_id
     where t.slug = $1 and d.id = $2 and d.kind = 'derived'`,
    [req.user!.tenant, req.params.id],
  )).rows[0]
  if (!row) return null
  const admin = req.user!.roles.includes('admin')
  if (!admin && row.owner_email !== req.user!.email) return null
  return { id: String(row.id), slug: String(row.slug) }
}

transformRouter.patch('/derived/:id', ...editorOnly, async (req, res) => {
  const ds = await findEditable(req)
  if (!ds) return res.status(404).json({ error: 'Conjunto derivado não encontrado (ou você não é o dono).' })
  const { name, description, sql, syncCadence } = req.body ?? {}
  if (sql != null) {
    try {
      await tryPreview(req.user!, String(sql))
      await assertNoDerivedCycle(req.user!.tenant, ds.slug, String(sql)) // cadeias sem ciclo
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message })
    }
  }
  if (syncCadence != null && !CADENCES.has(String(syncCadence))) {
    return res.status(400).json({ error: 'Cadência inválida.' })
  }
  await db.query(
    // schedule_id CAI JUNTO quando a cadência muda: a constraint
    // datasets_schedule_pairing_check exige 'schedule' e schedule_id sempre
    // emparelhados, e esta rota só grava relógio fixo ou cascata. Sem isto,
    // tirar um derivado do agendamento em lote produz o par proibido e o
    // Postgres recusa a linha inteira — foi exatamente assim que a
    // padronização das fontes teve 100% de um lote rejeitado.
    `update datasets set
       name = coalesce($2, name), description = coalesce($3, description),
       transform_sql = coalesce($4, transform_sql),
       sync_cadence = coalesce($5, sync_cadence),
       schedule_id = case when $5 is null then schedule_id else null end,
       updated_at = now()
     where id = $1`,
    [ds.id, name ?? null, description ?? null, sql ?? null, syncCadence ? String(syncCadence) : null],
  )
  if (sql != null) void enqueueSync(ds.id) // SQL mudou → re-materializa
  await audit(req, 'datasets.derived.update', { type: 'dataset', id: ds.slug }, { sqlChanged: sql != null })
  res.json({ ok: true, rematerializing: sql != null })
})

transformRouter.post('/derived/:id/materialize', ...editorOnly, async (req, res) => {
  const ds = await findEditable(req)
  if (!ds) return res.status(404).json({ error: 'Conjunto derivado não encontrado (ou você não é o dono).' })
  void enqueueSync(ds.id)
  await audit(req, 'datasets.derived.materialize', { type: 'dataset', id: ds.slug })
  res.status(202).json({ queued: true })
})
