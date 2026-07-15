// ─────────────────────────────────────────────────────────────────────────
// Integrações: tokens de acesso + API pública de leitura.
//   Autenticado:  GET/POST/DELETE /api/v1/credentials   (gestão de tokens)
//   Público:      GET /public/v1/datasets/:slug/rows?token=…&format=csv|json
// O token é exibido UMA única vez na criação; só o hash é guardado.
// A API pública roda como NÃO-admin: sensíveis mascarados, ocultos fora.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import type { FieldType } from '@datahub/shared'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { compileQuery } from '../query/compile.js'
import { duckQuery } from '../query/duck.js'

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

// ─── Gestão de tokens (autenticado) ────────────────────────────
export const credentialsRouter = Router()

credentialsRouter.get('/', requireAuth(), requireDb, async (req, res) => {
  const rows = (await db.query(
    `select c.id, c.name, c.dataset_slugs, c.owner_email, c.revoked, c.last_used_at, c.expires_at, c.created_at
       from api_credentials c join tenants t on t.id = c.tenant_id
      where t.slug = $1 order by c.created_at desc`,
    [req.user!.tenant],
  )).rows
  res.json({ credentials: rows })
})

credentialsRouter.post('/', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const { name, datasetSlugs, expiresInDays } = req.body ?? {}
  if (!name) return res.status(400).json({ error: 'Informe um nome para o token.' })
  const token = `dhub_${randomBytes(24).toString('base64url')}`
  const expiresAt = Number(expiresInDays) > 0
    ? new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
    : null
  const row = (await db.query(
    `insert into api_credentials (tenant_id, name, token_hash, dataset_slugs, owner_email, expires_at)
     select t.id, $1, $2, $3, $4, $5 from tenants t where t.slug = $6 returning id`,
    [String(name).trim(), hash(token), Array.isArray(datasetSlugs) ? datasetSlugs : [],
     req.user!.email, expiresAt, req.user!.tenant],
  )).rows[0]
  await audit(req, 'credentials.create', { type: 'credential', id: String(row.id) }, { name })
  // O token em claro só existe nesta resposta.
  res.status(201).json({ id: row.id, token })
})

credentialsRouter.delete('/:id', requireAuth({ role: 'editor' }), requireDb, async (req, res) => {
  const row = (await db.query(
    `update api_credentials set revoked = true where id = $1 returning name`,
    [req.params.id],
  )).rows[0]
  if (!row) return res.status(404).json({ error: 'Token não encontrado.' })
  await audit(req, 'credentials.revoke', { type: 'credential', id: req.params.id }, { name: row.name })
  res.json({ ok: true })
})

// ─── API pública (token) ───────────────────────────────────────
export const publicRouter = Router()

publicRouter.get('/datasets/:slug/rows', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Serviço indisponível.' })
  const token = String(req.query.token ?? req.headers['x-api-token'] ?? '')
  if (!token) return res.status(401).json({ error: 'Token ausente (?token=… ou header X-Api-Token).' })

  const cred = (await db.query(
    `select c.*, t.slug as tenant_slug from api_credentials c
      join tenants t on t.id = c.tenant_id where c.token_hash = $1`,
    [hash(token)],
  )).rows[0]
  if (!cred || cred.revoked) return res.status(401).json({ error: 'Token inválido ou revogado.' })
  if (cred.expires_at && new Date(cred.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Token expirado.' })
  }
  const slugs = (cred.dataset_slugs as string[]) ?? []
  if (slugs.length && !slugs.includes(req.params.slug)) {
    return res.status(403).json({ error: 'Este token não tem acesso a este conjunto de dados.' })
  }

  const ds = (await db.query(
    `select d.* from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [cred.tenant_slug, req.params.slug],
  )).rows[0]
  if (!ds) return res.status(404).json({ error: 'Conjunto de dados não encontrado.' })
  const dir = datasetDir(String(cred.tenant_slug), String(ds.slug))
  if (!listParquet(dir).length) return res.status(409).json({ error: 'Conjunto ainda não sincronizado.' })

  const fields = (await db.query(
    `select f.key, f.type, f.sensitive, f.label from dataset_fields f
      where f.dataset_id = $1 and not f.hidden order by f.sort_order`,
    [ds.id],
  )).rows as { key: string; type: FieldType; sensitive: boolean; label: string }[]

  const limit = Math.min(Math.max(1, Number(req.query.limit) || 10_000), 100_000)
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const format = String(req.query.format ?? (req.headers.accept === 'text/csv' ? 'csv' : 'json'))

  try {
    // Sempre como NÃO-admin: sensíveis mascarados, ocultos inexistentes.
    const compiled = compileQuery({ dataset: String(ds.slug), limit, offset }, fields, {
      admin: false, glob: parquetGlob(dir),
    })
    const { columns, rows } = await duckQuery(compiled.sql, compiled.params)
    const total = Number((await duckQuery(compiled.countSql!, compiled.countParams)).rows[0]?.n ?? 0)
    await db.query(`update api_credentials set last_used_at = now() where id = $1`, [cred.id])

    if (format === 'csv') {
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return ''
        const s = String(v)
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
      }
      const lines = [columns.join(';')]
      for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(';'))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.send('﻿' + lines.join('\r\n'))
      return
    }
    res.json({ dataset: ds.slug, total, limit, offset, rows })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})
