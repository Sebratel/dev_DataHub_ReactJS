// ─────────────────────────────────────────────────────────────────────────
// Apelidos de nome de conjunto (padrão de nomes, 19/11/2026).
//
// Renomear um conjunto deixa o nome antigo em dataset_slug_aliases. Este
// módulo guarda os apelidos na memória do processo e os aplica em três lugares,
// para que nada que já use o nome antigo quebre:
//   • URL — /api/v1/datasets/<antigo>/… (e a API pública, os acessos e o campo
//     do notebook) é reescrita para o nome novo antes de chegar às rotas;
//   • SQL — lakeRefs() acrescenta o nome antigo como mais uma referência ao
//     mesmo Parquet (calculado, notebook e modelo continuam rodando);
//   • dependências — referencedSlugs() entende o nome antigo como o conjunto
//     atual (a cascata, a lixeira e a conferência seguem enxergando quem cita).
// Fica em memória porque referencedSlugs é síncrona e roda centenas de vezes
// por rodada do agendador. É recarregado no boot e a cada renomeação.
// ─────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from 'express'
import { db } from '../db/pool.js'

export interface SlugAlias { tenantSlug: string; oldSlug: string; datasetId: string; currentSlug: string }

let apelidos: SlugAlias[] = []
let antigoParaAtual = new Map<string, string>()
let antigosDoAtual = new Map<string, string[]>()
let versao = 0

/** Muda a cada recarga — quem guarda expressões derivadas dos apelidos descarta o cache. */
export function slugAliasVersion(): number { return versao }

export async function loadSlugAliases(): Promise<number> {
  const rows = (await db.query(
    `select t.slug as tenant_slug, a.old_slug, a.dataset_id, d.slug as current_slug
       from dataset_slug_aliases a
       join datasets d on d.id = a.dataset_id
       join tenants t on t.id = a.tenant_id`,
  )).rows
  // Um nome antigo que hoje é o nome de algum conjunto (em qualquer tenant)
  // não vira apelido: o conjunto que tem o nome de verdade sempre vence.
  const atuais = new Set((await db.query('select slug from datasets')).rows.map((r) => String(r.slug)))
  apelidos = rows
    .map((r) => ({
      tenantSlug: String(r.tenant_slug), oldSlug: String(r.old_slug),
      datasetId: String(r.dataset_id), currentSlug: String(r.current_slug),
    }))
    .filter((a) => !atuais.has(a.oldSlug))
  antigoParaAtual = new Map(apelidos.map((a) => [a.oldSlug, a.currentSlug]))
  antigosDoAtual = new Map()
  for (const a of apelidos) antigosDoAtual.set(a.currentSlug, [...(antigosDoAtual.get(a.currentSlug) ?? []), a.oldSlug])
  versao++
  return apelidos.length
}

/** Nomes antigos que apontam para este conjunto (pelo nome atual). */
export function aliasesOfSlug(slug: string): string[] {
  return antigosDoAtual.get(slug) ?? []
}

/** Apelidos de um tenant, para o SQL do lake. */
export function aliasesForTenant(tenantSlug: string): SlugAlias[] {
  return apelidos.filter((a) => a.tenantSlug === tenantSlug)
}

/** O nome atual de um conjunto a partir de um nome antigo; null se não for apelido. */
export function currentSlugFor(slug: string): string | null {
  return antigoParaAtual.get(slug) ?? null
}

// Rotas que recebem o nome do conjunto no caminho. O resto da API usa o id.
const ROTAS = /^(\/api\/(?:v1|v1\/admin|public\/v1)\/datasets\/|\/api\/v1\/notebooks\/catalog\/)([^/?#]+)/

/** Middleware: troca o nome antigo pelo atual na URL, antes das rotas. */
export function resolveDatasetSlugAlias(req: Request, _res: Response, next: NextFunction): void {
  if (antigoParaAtual.size) {
    const m = ROTAS.exec(req.url)
    if (m) {
      let seg = m[2]
      try { seg = decodeURIComponent(seg) } catch { /* segmento malformado: segue como veio */ }
      const atual = antigoParaAtual.get(seg)
      if (atual) req.url = m[1] + encodeURIComponent(atual) + req.url.slice(m[0].length)
    }
  }
  next()
}
