// ─────────────────────────────────────────────────────────────────────────
// Administração de acessos (Sprint 8). Montado em /api/v1/admin.
//   Usuários (admin):      GET  /users               lista com papéis
//                          PATCH /users/:email/role  define papel (admin|editor|viewer)
//   Times (admin):         GET/POST /teams · PATCH/DELETE /teams/:id
//                          GET/POST /teams/:id/members · DELETE /teams/:id/members/:email
//   Concessões (admin ou DONO do conjunto):
//                          GET  /datasets/:slug/grants
//                          PATCH /datasets/:slug/visibility   (tenant|private)
//                          POST /datasets/:slug/grants        (time OU e-mail + canExport)
//                          PATCH /datasets/:slug/grants/:id   (canExport)
//                          DELETE /datasets/:slug/grants/:id
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'

export const accessRouter = Router()

accessRouter.use(requireAuth(), (req, res, next) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Banco de metadados indisponível.' })
  next()
})

const ROLES = ['admin', 'editor', 'viewer'] as const
const adminOnly = requireAuth({ role: 'admin' })

async function tenantId(slug: string): Promise<string> {
  return String((await db.query('select id from tenants where slug = $1', [slug])).rows[0]?.id)
}

function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'time'
}

// ─── Usuários ──────────────────────────────────────────────────
accessRouter.get('/users', adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select u.email, u.name, u.picture, u.last_login_at,
            coalesce(array_agg(r.name order by r.name) filter (where r.name is not null), '{}') as roles
       from users u
       left join user_roles ur on ur.user_id = u.id
       left join roles r on r.id = ur.role_id
      where u.tenant_id = (select id from tenants where slug = $1)
      group by u.id order by u.name`,
    [req.user!.tenant],
  )).rows
  res.json({
    users: rows.map((u) => ({
      email: u.email, name: u.name, picture: u.picture ?? null,
      lastLoginAt: u.last_login_at ? String(u.last_login_at) : null,
      roles: (u.roles as string[]) ?? [],
    })),
  })
})

accessRouter.patch('/users/:email/role', adminOnly, async (req, res) => {
  const role = String(req.body?.role ?? '')
  if (!ROLES.includes(role as never)) {
    return res.status(400).json({ error: `role deve ser um de: ${ROLES.join(', ')}.` })
  }
  const tid = await tenantId(req.user!.tenant)
  const user = (await db.query(
    'select id from users where email = $1 and tenant_id = $2', [req.params.email, tid],
  )).rows[0]
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' })
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query('delete from user_roles where user_id = $1', [user.id])
    await client.query(
      `insert into user_roles (user_id, role_id)
       select $1, r.id from roles r where r.tenant_id = $2 and r.name = $3`,
      [user.id, tid, role],
    )
    await client.query('commit')
  } catch (e) {
    await client.query('rollback'); throw e
  } finally { client.release() }
  await audit(req, 'access.user.role', { type: 'user', id: req.params.email }, { role })
  res.json({ ok: true })
})

// ─── Times ─────────────────────────────────────────────────────
accessRouter.get('/teams', adminOnly, async (req, res) => {
  const rows = (await db.query(
    `select tm.id, tm.slug, tm.name, tm.description,
            (select count(*) from team_members m where m.team_id = tm.id) as member_count
       from teams tm where tm.tenant_id = (select id from tenants where slug = $1)
      order by tm.name`,
    [req.user!.tenant],
  )).rows
  res.json({
    teams: rows.map((t) => ({
      id: String(t.id), slug: t.slug, name: t.name, description: t.description,
      memberCount: Number(t.member_count) || 0,
    })),
  })
})

accessRouter.post('/teams', adminOnly, async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Informe o nome do time.' })
  const tid = await tenantId(req.user!.tenant)
  const taken = new Set(
    (await db.query('select slug from teams where tenant_id = $1', [tid])).rows.map((r) => r.slug),
  )
  const base = slugify(name)
  let slug = base
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`
  const row = (await db.query(
    `insert into teams (tenant_id, slug, name, description) values ($1, $2, $3, $4) returning id`,
    [tid, slug, name, String(req.body?.description ?? '')],
  )).rows[0]
  await audit(req, 'access.team.create', { type: 'team', id: slug })
  res.status(201).json({ id: row.id, slug })
})

accessRouter.patch('/teams/:id', adminOnly, async (req, res) => {
  const { name, description } = req.body ?? {}
  const row = (await db.query(
    `update teams set name = coalesce($2, name), description = coalesce($3, description),
                      updated_at = now()
      where id = $1 and tenant_id = (select id from tenants where slug = $4) returning slug`,
    [req.params.id, name ?? null, description ?? null, req.user!.tenant],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Time não encontrado.' })
  await audit(req, 'access.team.update', { type: 'team', id: row.slug })
  res.json({ ok: true })
})

accessRouter.delete('/teams/:id', adminOnly, async (req, res) => {
  const row = (await db.query(
    `delete from teams where id = $1 and tenant_id = (select id from tenants where slug = $2) returning slug`,
    [req.params.id, req.user!.tenant],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Time não encontrado.' })
  await audit(req, 'access.team.delete', { type: 'team', id: row.slug })
  res.json({ ok: true })
})

// Garante que o time pertence ao tenant; devolve o id ou null.
async function teamInTenant(teamId: string, tenant: string): Promise<string | null> {
  const r = (await db.query(
    'select id from teams where id = $1 and tenant_id = (select id from tenants where slug = $2)',
    [teamId, tenant],
  )).rows[0]
  return r ? String(r.id) : null
}

accessRouter.get('/teams/:id/members', adminOnly, async (req, res) => {
  if (!(await teamInTenant(req.params.id, req.user!.tenant))) {
    return res.status(404).json({ error: 'Time não encontrado.' })
  }
  const rows = (await db.query(
    `select m.user_email, u.name from team_members m
       left join users u on u.email = m.user_email
      where m.team_id = $1 order by m.user_email`,
    [req.params.id],
  )).rows
  res.json({ members: rows.map((m) => ({ email: m.user_email, name: m.name ?? null })) })
})

accessRouter.post('/teams/:id/members', adminOnly, async (req, res) => {
  if (!(await teamInTenant(req.params.id, req.user!.tenant))) {
    return res.status(404).json({ error: 'Time não encontrado.' })
  }
  const email = String(req.body?.email ?? '').trim().toLowerCase()
  if (!email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail válido.' })
  await db.query(
    `insert into team_members (team_id, user_email) values ($1, $2) on conflict do nothing`,
    [req.params.id, email],
  )
  await audit(req, 'access.team.member.add', { type: 'team', id: req.params.id }, { email })
  res.status(201).json({ ok: true })
})

accessRouter.delete('/teams/:id/members/:email', adminOnly, async (req, res) => {
  if (!(await teamInTenant(req.params.id, req.user!.tenant))) {
    return res.status(404).json({ error: 'Time não encontrado.' })
  }
  await db.query(
    'delete from team_members where team_id = $1 and user_email = $2',
    [req.params.id, req.params.email.toLowerCase()],
  )
  await audit(req, 'access.team.member.remove', { type: 'team', id: req.params.id }, { email: req.params.email })
  res.json({ ok: true })
})

// ─── Concessões de dataset (admin OU dono do conjunto) ─────────
// Resolve o dataset por slug no tenant e checa se o usuário pode gerenciá-lo.
async function findManageableDataset(req: Request): Promise<{ id: string; slug: string } | null> {
  const row = (await db.query(
    `select d.id, d.slug, d.owner_email from datasets d
       join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, req.params.slug],
  )).rows[0]
  if (!row) return null
  const admin = req.user!.roles.includes('admin')
  if (!admin && row.owner_email !== req.user!.email) return null
  return { id: String(row.id), slug: String(row.slug) }
}

function requireManageable(handler: (req: Request, res: Response, ds: { id: string; slug: string }) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const ds = await findManageableDataset(req)
    if (!ds) return res.status(404).json({ error: 'Conjunto não encontrado (ou você não pode gerenciá-lo).' })
    await handler(req, res, ds)
  }
}

accessRouter.get('/datasets/:slug/grants', requireManageable(async (req, res, ds) => {
  const visibility = (await db.query('select visibility from datasets where id = $1', [ds.id])).rows[0]?.visibility
  const rows = (await db.query(
    `select g.id, g.team_id, g.grantee_email, g.can_export, g.created_at, tm.name as team_name
       from dataset_grants g left join teams tm on tm.id = g.team_id
      where g.dataset_id = $1 order by g.created_at`,
    [ds.id],
  )).rows
  // Times disponíveis para conceder (o dono, mesmo não-admin, precisa da lista).
  const teams = (await db.query(
    `select id, name from teams where tenant_id = (select id from tenants where slug = $1) order by name`,
    [req.user!.tenant],
  )).rows.map((t) => ({ id: String(t.id), name: String(t.name) }))
  res.json({
    visibility,
    teams,
    grants: rows.map((g) => ({
      id: String(g.id),
      teamId: g.team_id ? String(g.team_id) : null,
      teamName: g.team_name ?? null,
      email: g.grantee_email ?? null,
      canExport: !!g.can_export,
      createdAt: String(g.created_at),
    })),
  })
}))

accessRouter.patch('/datasets/:slug/visibility', requireManageable(async (req, res, ds) => {
  const visibility = String(req.body?.visibility ?? '')
  if (!['tenant', 'private'].includes(visibility)) {
    return res.status(400).json({ error: "visibility deve ser 'tenant' ou 'private'." })
  }
  await db.query('update datasets set visibility = $2, updated_at = now() where id = $1', [ds.id, visibility])
  await audit(req, 'access.dataset.visibility', { type: 'dataset', id: ds.slug }, { visibility })
  res.json({ ok: true })
}))

accessRouter.post('/datasets/:slug/grants', requireManageable(async (req, res, ds) => {
  const { teamId, email, canExport } = req.body ?? {}
  const hasTeam = !!teamId
  const hasEmail = !!email
  if (hasTeam === hasEmail) {
    return res.status(400).json({ error: 'Informe exatamente um: teamId OU email.' })
  }
  if (hasTeam && !(await teamInTenant(String(teamId), req.user!.tenant))) {
    return res.status(400).json({ error: 'Time não encontrado neste tenant.' })
  }
  const exportFlag = canExport !== false // padrão: pode exportar
  const target = hasTeam
    ? { col: 'team_id', val: String(teamId), conflict: 'dataset_grants_uq_team' }
    : { col: 'grantee_email', val: String(email).trim().toLowerCase(), conflict: 'dataset_grants_uq_email' }
  const row = (await db.query(
    `insert into dataset_grants (dataset_id, ${target.col}, can_export, created_by)
     values ($1, $2, $3, $4)
     on conflict on constraint ${target.conflict}
       do update set can_export = excluded.can_export
     returning id`,
    [ds.id, target.val, exportFlag, req.user!.email],
  )).rows[0]
  await audit(req, 'access.dataset.grant', { type: 'dataset', id: ds.slug },
    { teamId: teamId ?? null, email: email ?? null, canExport: exportFlag })
  res.status(201).json({ id: row.id })
}))

accessRouter.patch('/datasets/:slug/grants/:id', requireManageable(async (req, res, ds) => {
  const canExport = req.body?.canExport
  if (typeof canExport !== 'boolean') return res.status(400).json({ error: 'canExport (boolean) é obrigatório.' })
  const row = (await db.query(
    'update dataset_grants set can_export = $3 where id = $1 and dataset_id = $2 returning id',
    [req.params.id, ds.id, canExport],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Concessão não encontrada.' })
  await audit(req, 'access.dataset.grant.update', { type: 'dataset', id: ds.slug }, { canExport })
  res.json({ ok: true })
}))

accessRouter.delete('/datasets/:slug/grants/:id', requireManageable(async (req, res, ds) => {
  const row = (await db.query(
    'delete from dataset_grants where id = $1 and dataset_id = $2 returning id',
    [req.params.id, ds.id],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Concessão não encontrada.' })
  await audit(req, 'access.dataset.grant.revoke', { type: 'dataset', id: ds.slug })
  res.json({ ok: true })
}))
