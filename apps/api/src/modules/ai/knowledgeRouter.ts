// ─────────────────────────────────────────────────────────────────────────
// O que o assistente sabe de um conjunto, e a avaliação dele (27/11/2026).
//
//   GET  /ai/knowledge/:slug   — o conhecimento juntado (regras da tabela de
//                                origem, do pacote, notas da equipe, perfil).
//                                Quem lê o conjunto vê.
//   PUT  /ai/knowledge/:slug   — as notas da equipe. Admin ou dono do conjunto:
//                                a mesma regra de quem edita a descrição dele.
//   GET  /ai/eval              — as últimas rodadas da avaliação (admin).
//   POST /ai/eval              — roda a avaliação em segundo plano (admin).
// ─────────────────────────────────────────────────────────────────────────
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { db, isDbAvailable } from '../../db/pool.js'
import { requireAuth, audit } from '../auth/middleware.js'
import { canQuery } from '../../core/access.js'
import { currentSlugFor } from '../../core/slugAliases.js'
import { conhecimentoDoConjunto } from './tools.js'
import { activeProvider } from './providerStore.js'
import { CASOS, iniciaAvaliacao, avaliacaoEmAndamento } from './evaluation.js'

export const knowledgeRouter = Router()
export const evaluationRouter = Router()

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) { res.status(503).json({ error: 'Banco de metadados indisponível.' }); return }
  next()
}
const authed = [requireAuth(), requireDb]
const adminOnly = [requireAuth({ role: 'admin' }), requireDb]

// Texto livre, mas é prompt: o que entra aqui vai em toda pergunta sobre o
// conjunto. O teto evita que uma colagem de manual inteiro vire custo fixo.
const MAX_NOTAS = 8_000

async function conjunto(req: Request) {
  const slug = currentSlugFor(req.params.slug) ?? req.params.slug
  const ds = (await db.query(
    `select d.*, t.slug as tenant_slug from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.slug = $2`,
    [req.user!.tenant, slug],
  )).rows[0]
  if (!ds || !(await canQuery(req.user!, String(ds.id)))) return null
  return ds as Record<string, unknown>
}

const podeEnsinar = (req: Request, ds: Record<string, unknown>) =>
  req.user!.roles.includes('admin') || ds.owner_email === req.user!.email

knowledgeRouter.get('/:slug', ...authed, async (req, res) => {
  const ds = await conjunto(req)
  if (!ds) return res.status(404).json({ error: 'Conjunto não encontrado.' })
  try {
    const info = await conhecimentoDoConjunto(ds, { perfil: req.query.perfil !== 'false' })
    const meta = (await db.query(
      `select updated_by, updated_at from ai_dataset_notes where dataset_id = $1`, [ds.id],
    )).rows[0]
    res.json({
      ...info,
      notas: info.conhecimento.notas_da_equipe ?? '',
      notasAtualizadas: meta ? { por: meta.updated_by, em: meta.updated_at } : null,
      podeEnsinar: podeEnsinar(req, ds),
    })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

knowledgeRouter.put('/:slug', ...authed, async (req, res) => {
  const ds = await conjunto(req)
  if (!ds) return res.status(404).json({ error: 'Conjunto não encontrado.' })
  if (!podeEnsinar(req, ds)) {
    return res.status(403).json({ error: 'Só o dono do conjunto ou um administrador ensina o assistente sobre ele.' })
  }
  const notas = String(req.body?.notas ?? '').trim()
  if (notas.length > MAX_NOTAS) {
    return res.status(400).json({ error: `Use até ${MAX_NOTAS.toLocaleString('pt-BR')} caracteres — o texto vai junto em toda pergunta sobre o conjunto.` })
  }
  await db.query(
    `insert into ai_dataset_notes (dataset_id, tenant_id, notes, updated_by, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (dataset_id) do update set notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [ds.id, ds.tenant_id, notas, req.user!.email],
  )
  await audit(req, 'ai.knowledge.update', { type: 'dataset', id: String(ds.slug) }, { chars: notas.length })
  res.json({ ok: true })
})

// ── Avaliação ────────────────────────────────────────────────────────────
evaluationRouter.get('/', ...adminOnly, async (req, res) => {
  const runs = (await db.query(
    `select r.id, r.started_by, r.started_at, r.finished_at, r.status, r.provider, r.model,
            r.total, r.passed, r.skipped, r.results, r.error
       from ai_eval_runs r join tenants t on t.id = r.tenant_id
      where t.slug = $1 order by r.started_at desc limit 10`,
    [req.user!.tenant],
  )).rows
  res.json({
    runs: runs.map((r) => ({
      ...r,
      results: typeof r.results === 'string' ? JSON.parse(r.results) : (r.results ?? []),
    })),
    emAndamento: avaliacaoEmAndamento(),
    casos: CASOS.map((c) => ({ id: c.id, tema: c.tema, pergunta: c.pergunta })),
  })
})

evaluationRouter.post('/', ...adminOnly, async (req, res) => {
  const provider = activeProvider(req.user!.tenant)
  if (!provider?.isConfigured()) {
    return res.status(503).json({ error: 'IA não configurada. Cadastre um provedor em Administração › Provedores de IA.' })
  }
  const ids = Array.isArray(req.body?.casos) ? (req.body.casos as unknown[]).map(String) : undefined
  try {
    const id = await iniciaAvaliacao(req.user!, provider, ids)
    await audit(req, 'ai.eval.start', { type: 'ai_eval', id }, { model: provider.model, casos: ids?.length ?? CASOS.length })
    res.status(202).json({ id })
  } catch (e) {
    res.status(409).json({ error: (e as Error).message })
  }
})
