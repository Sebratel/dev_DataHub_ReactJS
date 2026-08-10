// ─────────────────────────────────────────────────────────────────────────
// Notebooks: análise rápida sobre o lake.
//
// Uma célula SQL é, no fundo, a mesma coisa que a prévia de um derivado —
// mesmo motor, mesmo guard, mesma regra de acesso. O que o notebook acrescenta
// é continuidade (várias células, salvas) e a ponte para o resto da
// plataforma: "materializar como conjunto" transforma a exploração em algo
// governado, com linhagem, permissão e atualização diária.
//
// Toda execução vai para a PISTA AD-HOC do motor: SQL livre é imprevisível e
// não pode competir por slot com os painéis.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { config } from '../../core/config.js'
import { duckQuery } from '../query/duck.js'
import {
  lakeRefs, buildLakeSql, validateTransformSql, assertReferencesAllowed,
} from '../transform/derive.js'
import { enqueueSync } from '../sync/ingest.js'
import type { AccessUser } from '../../core/access.js'

export const notebooksRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const authed = [requireAuth(), requireDb]
const fail = (res: Response, e: unknown) => res.status(400).json({ error: (e as Error).message })

// Teto de linhas devolvidas ao navegador. O motor aguenta muito mais, mas cada
// linha vira objeto JS no servidor e depois JSON na rede — é o Node e a aba do
// navegador que quebram primeiro, não o DuckDB.
const MAX_CELL_ROWS = 5_000

function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'notebook'
}

// ── Acesso ───────────────────────────────────────────────────────────────
// Mesma regra dos conjuntos: admin vê tudo, dono vê o próprio, 'tenant' é
// aberto, e o resto depende de concessão por e-mail ou por time.
const READ_PREDICATE = `(
  n.visibility = 'tenant'
  or n.owner_email = $EMAIL
  or exists (select 1 from notebook_grants g
              where g.notebook_id = n.id and g.grantee_email = $EMAIL)
  or exists (select 1 from notebook_grants g
               join team_members m on m.team_id = g.team_id
              where g.notebook_id = n.id and m.user_email = $EMAIL)
)`

interface NotebookRow {
  id: string
  slug: string
  owner_email: string
  visibility: 'private' | 'tenant'
  cells: unknown
  [k: string]: unknown
}

async function findReadable(user: AccessUser, slug: string): Promise<NotebookRow | null> {
  const admin = user.roles.includes('admin')
  const row = (await db.query(
    `select n.* from notebooks n join tenants t on t.id = n.tenant_id
      where t.slug = $1 and n.slug = $2 and ($3 or ${READ_PREDICATE.replace(/\$EMAIL/g, '$4')})`,
    [user.tenant, slug, admin, user.email],
  )).rows[0]
  return (row as NotebookRow) ?? null
}

// Editar exige ser dono, admin, ou ter concessão com can_edit.
async function canEdit(user: AccessUser, notebookId: string): Promise<boolean> {
  if (user.roles.includes('admin')) return true
  const r = await db.query(
    `select 1 from notebooks n
      where n.id = $1 and (
        n.owner_email = $2
        or exists (select 1 from notebook_grants g
                    where g.notebook_id = n.id and g.can_edit
                      and (g.grantee_email = $2
                           or g.team_id in (select team_id from team_members where user_email = $2))))
      limit 1`,
    [notebookId, user.email],
  )
  return (r.rowCount ?? 0) > 0
}

// ── Catálogo de referência ───────────────────────────────────────────────
// O que a pessoa pode escrever no SQL. Sem isto ela adivinha nomes e recebe
// "tabela não existe" sem saber o que existe.
notebooksRouter.get('/catalog', ...authed, async (req, res) => {
  const refs = await lakeRefs(req.user!.tenant, { user: req.user! })
  const slugs = refs.map((r) => r.slug)
  const meta = slugs.length
    ? (await db.query(
        `select d.slug, d.name, d.kind, d.row_count,
                (select count(*) from dataset_fields f where f.dataset_id = d.id and not f.hidden) as field_count
           from datasets d join tenants t on t.id = d.tenant_id
          where t.slug = $1 and d.slug = any($2::text[])`,
        [req.user!.tenant, slugs],
      )).rows
    : []
  res.json({
    datasets: meta.map((m) => ({
      slug: String(m.slug),
      alias: String(m.slug).replace(/-/g, '_'), // como se escreve no SQL
      name: String(m.name),
      kind: String(m.kind),
      rowCount: m.row_count === null ? null : Number(m.row_count),
      fieldCount: Number(m.field_count),
    })),
  })
})

// Colunas de um conjunto — para o painel lateral do editor.
notebooksRouter.get('/catalog/:slug/fields', ...authed, async (req, res) => {
  const refs = await lakeRefs(req.user!.tenant, { user: req.user! })
  if (!refs.some((r) => r.slug === req.params.slug)) {
    return res.status(403).json({ error: 'Você não tem acesso a este conjunto.' })
  }
  const rows = (await db.query(
    `select f.key, f.label, f.type from dataset_fields f
       join datasets d on d.id = f.dataset_id
       join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2 and not f.hidden
      order by f.sort_order`,
    [req.user!.tenant, req.params.slug],
  )).rows
  res.json({ fields: rows })
})

// ── CRUD ─────────────────────────────────────────────────────────────────
notebooksRouter.get('/', ...authed, async (req, res) => {
  const admin = req.user!.roles.includes('admin')
  const rows = (await db.query(
    `select n.id, n.slug, n.name, n.description, n.visibility, n.owner_email,
            n.created_at, n.updated_at,
            jsonb_array_length(n.cells) as cell_count
       from notebooks n join tenants t on t.id = n.tenant_id
      where t.slug = $1 and ($2 or ${READ_PREDICATE.replace(/\$EMAIL/g, '$3')})
      order by n.updated_at desc`,
    [req.user!.tenant, admin, req.user!.email],
  )).rows
  res.json({ notebooks: rows })
})

notebooksRouter.post('/', ...authed, async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Informe um nome para o notebook.' })
  try {
    const tenant = (await db.query('select id from tenants where slug = $1', [req.user!.tenant])).rows[0]
    const taken = new Set(
      (await db.query('select slug from notebooks where tenant_id = $1', [tenant.id])).rows.map((r) => r.slug),
    )
    const base = slugify(name)
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

    const cells = Array.isArray(req.body?.cells) && req.body.cells.length
      ? req.body.cells
      : [{ id: 'c1', kind: 'sql', source: '' }]

    const row = (await db.query(
      `insert into notebooks (tenant_id, slug, name, description, cells, visibility, owner_email)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [tenant.id, slug, name, String(req.body?.description ?? ''), JSON.stringify(cells),
       req.body?.visibility === 'tenant' ? 'tenant' : 'private', req.user!.email],
    )).rows[0]
    await audit(req, 'notebooks.create', { type: 'notebook', id: slug })
    res.status(201).json({ notebook: row })
  } catch (e) { fail(res, e) }
})

notebooksRouter.get('/:slug', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })
  res.json({ notebook: nb, canEdit: await canEdit(req.user!, nb.id) })
})

notebooksRouter.put('/:slug', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })
  if (!(await canEdit(req.user!, nb.id))) {
    return res.status(403).json({ error: 'Você tem acesso de leitura a este notebook.' })
  }
  const { name, description, cells, visibility } = req.body ?? {}
  try {
    const row = (await db.query(
      `update notebooks set
         name = coalesce($2, name),
         description = coalesce($3, description),
         cells = coalesce($4::jsonb, cells),
         visibility = coalesce($5, visibility),
         updated_at = now()
       where id = $1 returning *`,
      [nb.id, name ?? null, description ?? null,
       cells ? JSON.stringify(cells) : null,
       visibility === 'tenant' || visibility === 'private' ? visibility : null],
    )).rows[0]
    res.json({ notebook: row })
  } catch (e) { fail(res, e) }
})

notebooksRouter.delete('/:slug', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })
  if (nb.owner_email !== req.user!.email && !req.user!.roles.includes('admin')) {
    return res.status(403).json({ error: 'Só o dono (ou um administrador) pode excluir.' })
  }
  await db.query('delete from notebooks where id = $1', [nb.id])
  await audit(req, 'notebooks.delete', { type: 'notebook', id: req.params.slug })
  res.json({ ok: true })
})

// ── Compartilhamento ─────────────────────────────────────────────────────
// Mesmo modelo dos painéis: visibilidade (privado/time) + concessões por e-mail
// ou por time. Diferença de tabela: notebook_grants tem chave COMPOSTA em vez
// de id, então a remoção é por e-mail/time — evita uma migration só para ganhar
// uma coluna de id.
//
// Só o DONO (ou admin) compartilha. Quem recebeu acesso de edição pode editar o
// notebook, mas não redistribuí-lo — senão o dono perde o controle de quem vê.
async function isOwner(user: AccessUser, nb: NotebookRow): Promise<boolean> {
  return nb.owner_email === user.email || user.roles.includes('admin')
}

notebooksRouter.get('/:slug/shares', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })

  const grants = (await db.query(
    `select g.grantee_email, g.team_id, g.can_edit, tm.name as team_name
       from notebook_grants g left join teams tm on tm.id = g.team_id
      where g.notebook_id = $1 order by g.created_at`,
    [nb.id],
  )).rows.map((g) => ({
    teamId: g.team_id ? String(g.team_id) : null,
    teamName: (g.team_name as string | null) ?? null,
    email: (g.grantee_email as string | null) ?? null,
    canEdit: g.can_edit === true,
  }))

  const teams = (await db.query(
    `select id, name from teams where tenant_id = (select id from tenants where slug = $1) order by name`,
    [req.user!.tenant],
  )).rows.map((t) => ({ id: String(t.id), name: String(t.name) }))

  res.json({
    visibility: nb.visibility,
    ownerEmail: nb.owner_email,
    canShare: await isOwner(req.user!, nb),
    teams,
    grants,
  })
})

notebooksRouter.post('/:slug/shares', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })
  if (!(await isOwner(req.user!, nb))) {
    return res.status(403).json({ error: 'Só o dono (ou um administrador) pode compartilhar.' })
  }

  const { teamId, email } = req.body ?? {}
  const canEdit = (req.body ?? {}).canEdit === true
  const hasTeam = !!teamId
  const hasEmail = !!email
  if (hasTeam === hasEmail) {
    return res.status(400).json({ error: 'Informe exatamente um: um time OU um e-mail.' })
  }

  try {
    if (hasTeam) {
      const ok = (await db.query(
        'select 1 from teams where id = $1 and tenant_id = (select id from tenants where slug = $2)',
        [teamId, req.user!.tenant],
      )).rows[0]
      if (!ok) return res.status(400).json({ error: 'Time não encontrado neste tenant.' })
      await db.query(
        `insert into notebook_grants (notebook_id, team_id, can_edit) values ($1, $2, $3)
         on conflict (notebook_id, team_id) where team_id is not null
         do update set can_edit = excluded.can_edit`,
        [nb.id, String(teamId), canEdit],
      )
    } else {
      const addr = String(email).toLowerCase().trim()
      if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return res.status(400).json({ error: 'Informe um e-mail válido.' })
      if (addr === nb.owner_email) return res.status(400).json({ error: 'O dono já tem acesso total.' })
      await db.query(
        `insert into notebook_grants (notebook_id, grantee_email, can_edit) values ($1, $2, $3)
         on conflict (notebook_id, grantee_email) where grantee_email is not null
         do update set can_edit = excluded.can_edit`,
        [nb.id, addr, canEdit],
      )
    }
    await audit(req, 'notebooks.share', { type: 'notebook', id: req.params.slug },
      { teamId: teamId ?? null, email: email ?? null, canEdit })
    res.status(201).json({ ok: true })
  } catch (e) { fail(res, e) }
})

// Remoção por e-mail OU time (a tabela não tem id próprio).
notebooksRouter.delete('/:slug/shares', ...authed, async (req, res) => {
  const nb = await findReadable(req.user!, req.params.slug)
  if (!nb) return res.status(404).json({ error: 'Notebook não encontrado.' })
  if (!(await isOwner(req.user!, nb))) {
    return res.status(403).json({ error: 'Só o dono (ou um administrador) pode alterar o compartilhamento.' })
  }
  const email = typeof req.query.email === 'string' ? req.query.email.toLowerCase() : null
  const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : null
  if (!email && !teamId) return res.status(400).json({ error: 'Informe o e-mail ou o time a remover.' })

  await db.query(
    email
      ? `delete from notebook_grants where notebook_id = $1 and grantee_email = $2`
      : `delete from notebook_grants where notebook_id = $1 and team_id = $2`,
    [nb.id, email ?? teamId],
  )
  await audit(req, 'notebooks.unshare', { type: 'notebook', id: req.params.slug }, { email, teamId })
  res.json({ ok: true })
})

// ── Execução de célula ───────────────────────────────────────────────────
// Não precisa que a célula esteja salva: o editor executa enquanto se digita.
// Por isso a permissão é conferida SEMPRE aqui, sobre o SQL que chegou agora —
// nunca sobre o que estava guardado.
notebooksRouter.post('/run', ...authed, async (req, res) => {
  const sql = String(req.body?.sql ?? '').trim()
  if (!sql) return res.status(400).json({ error: 'Célula vazia.' })
  const limit = Math.min(Math.max(1, Number(req.body?.limit) || 500), MAX_CELL_ROWS)
  const started = Date.now()

  try {
    validateTransformSql(sql)
    await assertReferencesAllowed(req.user!.tenant, sql, req.user!)
    const refs = await lakeRefs(req.user!.tenant, { user: req.user! })
    const wrapped = buildLakeSql(sql, refs)

    // Pede uma linha a mais que o limite: é assim que dá para dizer "há mais"
    // com honestidade, sem contar o total (que custaria uma segunda varredura).
    const result = await duckQuery(
      `select * from (${wrapped}) as __nb limit ${limit + 1}`,
      [],
      { timeoutMs: config.duck.queryTimeoutMs, adhoc: true },
    )
    const truncated = result.rows.length > limit
    res.json({
      columns: result.columns,
      rows: truncated ? result.rows.slice(0, limit) : result.rows,
      truncated,
      ms: Date.now() - started,
    })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, ms: Date.now() - started })
  }
})

// ── Materializar como conjunto ───────────────────────────────────────────
// A ponte que faz o notebook valer mais que um cliente SQL: o resultado da
// exploração vira conjunto derivado — com linhagem, permissão, atualização
// diária e disponível para painéis, métricas, APIs e modelos.
notebooksRouter.post('/materialize', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const sql = String(req.body?.sql ?? '').trim()
  const name = String(req.body?.name ?? '').trim()
  if (!sql || !name) return res.status(400).json({ error: 'Informe o nome e o SQL.' })

  try {
    validateTransformSql(sql)
    await assertReferencesAllowed(req.user!.tenant, sql, req.user!)

    // Prova que o SQL roda ANTES de criar o conjunto: um derivado quebrado no
    // catálogo é pior que um erro na tela.
    const refs = await lakeRefs(req.user!.tenant, { user: req.user! })
    await duckQuery(
      `select * from (${buildLakeSql(sql, refs)}) as __p limit 1`,
      [],
      { timeoutMs: config.duck.queryTimeoutMs, adhoc: true },
    )

    const tenant = (await db.query('select id from tenants where slug = $1', [req.user!.tenant])).rows[0]
    const taken = new Set(
      (await db.query('select slug from datasets where tenant_id = $1', [tenant.id])).rows.map((r) => r.slug),
    )
    const base = slugify(name)
    let slug = base
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`

    const ds = (await db.query(
      `insert into datasets (tenant_id, kind, transform_sql, connection_id, schema_name, object_name,
                             slug, name, description, sync_mode, owner_email)
       values ($1, 'derived', $2, 'lake', 'derived', $3, $3, $4, $5, 'snapshot', $6)
       returning id`,
      [tenant.id, sql, slug, name,
       String(req.body?.description ?? 'Materializado a partir de um notebook.'), req.user!.email],
    )).rows[0]

    void enqueueSync(String(ds.id)) // primeira materialização em background
    await audit(req, 'notebooks.materialize', { type: 'dataset', id: slug }, { from: 'notebook' })
    res.status(201).json({ id: ds.id, slug })
  } catch (e) { fail(res, e) }
})
