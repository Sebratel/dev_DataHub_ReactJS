// ─────────────────────────────────────────────────────────────────────────
// Conjuntos DERIVADOS: SQL (DuckDB) escrito por editores sobre conjuntos JÁ
// ingeridos, materializado como Parquet novo no lake. Zero carga nas fontes:
// tudo roda sobre a cópia local (padrão bronze → prata dos lakehouses).
//
// O SQL do usuário referencia conjuntos pelo slug ("massiva-history") ou pelo
// apelido com underscore (massiva_history). Internamente viram CTEs sobre
// read_parquet — o usuário nunca vê caminhos de arquivo.
// ─────────────────────────────────────────────────────────────────────────
import { join } from 'node:path'
import { db } from '../../db/pool.js'
import { config } from '../../core/config.js'
import { datasetDir, parquetGlob, listParquet, clearParquet, dirBytes, uploadToGcs } from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'
import { assertReadOnly, stripNoise } from '../../core/guard.js'
import { accessibleDatasetIds, type AccessUser } from '../../core/access.js'
import type { FieldType } from '@datahub/shared'

// Além do guard read-only: bloqueia funções do DuckDB que alcançam o sistema
// de arquivos ou a configuração — o SQL derivado só enxerga os CTEs do lake.
const EXTRA_FORBIDDEN = /\b(read_[a-z0-9_]*|[a-z0-9_]*_scan|glob|getenv|attach|detach|install|load|pragma|set|reset|checkpoint|export_state|use)\b/i

export function validateTransformSql(sql: string): void {
  assertReadOnly(sql)
  const m = EXTRA_FORBIDDEN.exec(stripNoise(sql))
  if (m) {
    throw new Error(
      `Função/comando não permitido no SQL derivado: "${m[0]}". ` +
      'Use apenas SELECT sobre os conjuntos do lake (referencie-os pelo slug).',
    )
  }
}

export interface LakeRef {
  slug: string
  glob: string
}

export interface LakeRefOptions {
  /** Evita um derivado referenciar a si mesmo (leria a versão anterior). */
  excludeSlug?: string
  /**
   * Quando presente, só entram conjuntos que ESTE usuário pode ler.
   *
   * Sem isto, qualquer pessoa que escreva SQL aqui alcança todo conjunto do
   * tenant só digitando o slug — inclusive os restritos por dataset_grants.
   * A regra: caminho INTERATIVO (prévia, onde a pessoa digita SQL livre) passa
   * o usuário; caminho de EXECUÇÃO de uma definição já salva e validada
   * (materialização, treino) roda com o tenant inteiro, como o scheduler.
   */
  user?: AccessUser
}

// Conjuntos do tenant (FONTE ou DERIVADO) que já têm Parquet no lake e podem
// ser referenciados. Derivados entram também → cadeias (derivado sobre
// derivado); a ordem de atualização é resolvida por ordenação topológica no
// scheduler.
export async function lakeRefs(tenantSlug: string, opts: LakeRefOptions = {}): Promise<LakeRef[]> {
  const rows = (await db.query(
    `select d.id, d.slug from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind in ('source', 'derived')`,
    [tenantSlug],
  )).rows

  const allowed = opts.user ? await accessibleDatasetIds(opts.user) : null

  const refs: LakeRef[] = []
  for (const r of rows) {
    const slug = String(r.slug)
    if (opts.excludeSlug && slug === opts.excludeSlug) continue
    if (allowed && !allowed.has(String(r.id))) continue
    const dir = datasetDir(tenantSlug, slug)
    if (listParquet(dir).length) refs.push({ slug, glob: parquetGlob(dir) })
  }
  return refs
}

// Trava de AUTORIA: o SQL salvo só pode referenciar conjuntos que o autor
// alcança. É o par da regra acima — a execução confia na definição justamente
// porque a autoria foi conferida aqui.
export async function assertReferencesAllowed(
  tenantSlug: string, sql: string, user: AccessUser,
): Promise<void> {
  const all = (await db.query(
    `select d.slug from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind in ('source', 'derived')`,
    [tenantSlug],
  )).rows.map((r) => String(r.slug))

  const referenced = referencedSlugs(sql, all)
  if (!referenced.length) return

  const allowed = await lakeRefs(tenantSlug, { user })
  const allowedSet = new Set(allowed.map((r) => r.slug))
  const denied = referenced.filter((s) => !allowedSet.has(s))
  if (denied.length) {
    throw new Error(
      `Você não tem acesso a: ${denied.join(', ')}. ` +
      'Peça a concessão ao dono do conjunto antes de referenciá-lo.',
    )
  }
}

// ── Cadeias de derivados: dependências, ordenação e ciclos ─────
// Slugs (dentre `candidates`) referenciados no SQL. Detecta o APELIDO com
// underscore (sem aspas) e o SLUG entre aspas. Ignora comentários e literais.
export function referencedSlugs(sql: string, candidates: string[]): string[] {
  const clean = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .toLowerCase()
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hits: string[] = []
  for (const slug of candidates) {
    const alias = slug.replace(/-/g, '_')
    const aliasRe = new RegExp(`(?<![a-z0-9_])${esc(alias)}(?![a-z0-9_])`)
    const quotedRe = new RegExp(`"${esc(slug)}"`)
    if (aliasRe.test(clean) || quotedRe.test(clean)) hits.push(slug)
  }
  return hits
}

export interface DerivedNode { slug: string; transformSql: string | null }

// Ordena derivados para materialização: quem referencia outro roda DEPOIS.
// Resiliente — em ciclo, loga e mantém uma ordem parcial (não derruba o sync).
export function orderDerived<T extends DerivedNode>(deriveds: T[]): T[] {
  const bySlug = new Map(deriveds.map((d) => [d.slug, d]))
  const slugs = deriveds.map((d) => d.slug)
  const deps = new Map(deriveds.map((d) => [d.slug, referencedSlugs(d.transformSql ?? '', slugs).filter((s) => s !== d.slug)]))
  const state = new Map<string, 1 | 2>()
  const out: T[] = []
  const visit = (slug: string) => {
    const st = state.get(slug)
    if (st === 2) return
    if (st === 1) { console.warn(`[derive] ciclo de dependência envolvendo "${slug}" — ordem parcial.`); return }
    state.set(slug, 1)
    for (const dep of deps.get(slug) ?? []) if (bySlug.has(dep)) visit(dep)
    state.set(slug, 2)
    out.push(bySlug.get(slug)!)
  }
  for (const d of deriveds) visit(d.slug)
  return out
}

function graphHasCycle(deps: Map<string, string[]>): boolean {
  const state = new Map<string, 1 | 2>()
  let cyclic = false
  const visit = (s: string) => {
    if (cyclic) return
    state.set(s, 1)
    for (const d of deps.get(s) ?? []) {
      const st = state.get(d)
      if (st === 1) { cyclic = true; return }
      if (st === undefined) visit(d)
    }
    state.set(s, 2)
  }
  for (const s of deps.keys()) if (state.get(s) === undefined) visit(s)
  return cyclic
}

// Bloqueia salvar um derivado cujo SQL crie dependência circular entre derivados.
export async function assertNoDerivedCycle(tenantSlug: string, slug: string, newSql: string): Promise<void> {
  const rows = (await db.query(
    `select d.slug, d.transform_sql from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind = 'derived'`,
    [tenantSlug],
  )).rows
  const graph: DerivedNode[] = rows.map((r) => ({
    slug: String(r.slug),
    transformSql: String(r.slug) === slug ? newSql : (r.transform_sql as string | null),
  }))
  if (!graph.some((g) => g.slug === slug)) graph.push({ slug, transformSql: newSql })
  const all = graph.map((g) => g.slug)
  const deps = new Map(graph.map((g) => [g.slug, referencedSlugs(g.transformSql ?? '', all).filter((s) => s !== g.slug)]))
  if (graphHasCycle(deps)) {
    throw new Error('Este SQL cria uma dependência circular entre conjuntos derivados (eles passariam a se referenciar em ciclo).')
  }
}

// Envolve o SQL do usuário com CTEs (um por conjunto do lake). O SQL vira uma
// subconsulta — funciona mesmo quando o usuário usa o próprio WITH.
export function buildLakeSql(userSql: string, refs: LakeRef[]): string {
  if (!refs.length) {
    throw new Error('Nenhum conjunto de dados com dados no lake — sincronize as fontes primeiro.')
  }
  const ctes: string[] = []
  for (const r of refs) {
    ctes.push(`"${r.slug}" as (select * from read_parquet('${r.glob}'))`)
    const alias = r.slug.replace(/-/g, '_')
    if (alias !== r.slug) ctes.push(`"${alias}" as (select * from "${r.slug}")`)
  }
  const body = userSql.trim().replace(/;\s*$/, '')
  return `with ${ctes.join(',\n     ')}\nselect * from (\n${body}\n) as __derivado`
}

// Erro de "tabela não existe" do DuckDB → mensagem que explica as 3 causas
// possíveis e lista o que ESTÁ disponível (apelidos com underscore).
function friendlyDuckError(e: Error, refs: LakeRef[]): Error {
  const m = /Table with name (\S+) does not exist/.exec(e.message)
  if (!m) return e
  const available = refs.map((r) => r.slug.replace(/-/g, '_')).join(', ')
  return new Error(
    `O conjunto "${m[1]}" não está disponível no lake. ` +
    'Verifique se: (1) o apelido está correto — use o slug com underscore; ' +
    '(2) o conjunto (fonte OU derivado) já foi sincronizado/materializado; ' +
    '(3) a sincronização realmente rodou (metadado pode indicar sync sem os arquivos no lake — re-sincronize). ' +
    `Disponíveis agora: ${available || 'nenhum'}.`,
  )
}

// Amostra do resultado (LIMIT 50) — validação/preview antes de criar/salvar.
export async function previewDerived(
  tenantSlug: string, sql: string, user?: AccessUser,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  validateTransformSql(sql)
  // Prévia é caminho INTERATIVO: o usuário digita SQL livre, então só enxerga
  // os conjuntos que ele pode ler.
  const refs = await lakeRefs(tenantSlug, { user })
  const wrapped = buildLakeSql(sql, refs)
  try {
    const res = await duckQuery(`select * from (${wrapped}) as __p limit 50`, [], { timeoutMs: config.duck.queryTimeoutMs, adhoc: true })
    return { columns: res.columns, rows: res.rows }
  } catch (e) {
    throw friendlyDuckError(e as Error, refs)
  }
}

// Tipo DuckDB → taxonomia do catálogo.
function mapDuckType(t: string): FieldType {
  const up = t.toUpperCase()
  if (/INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/.test(up)) return 'number'
  if (/BOOL/.test(up)) return 'bool'
  if (/DATE|TIME/.test(up)) return 'date'
  if (/JSON|STRUCT|LIST|MAP/.test(up)) return 'json'
  return 'text'
}

function labelize(column: string): string {
  return column.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Sincroniza dataset_fields com o schema do Parquet materializado: campos
// novos entram, tipos são atualizados, campos removidos saem — mas label,
// oculto e sensível de quem já existia são PRESERVADOS.
async function refreshFields(datasetId: string, partGlobPath: string): Promise<string[]> {
  const desc = await duckQuery(`describe select * from read_parquet('${partGlobPath}')`)
  const keys: string[] = []
  for (const [i, row] of desc.rows.entries()) {
    const key = String(row.column_name)
    keys.push(key)
    await db.query(
      `insert into dataset_fields (dataset_id, source_column, key, label, type, sort_order)
       values ($1, $2, $2, $3, $4, $5)
       on conflict (dataset_id, key) do update set type = excluded.type, sort_order = excluded.sort_order`,
      [datasetId, key, labelize(key), mapDuckType(String(row.column_type)), i],
    )
  }
  await db.query(
    `delete from dataset_fields where dataset_id = $1 and key <> all($2::text[])`,
    [datasetId, keys],
  )
  return keys
}

// Materializa o derivado: roda o SQL sobre o lake e grava Parquet (zstd),
// substituindo as partes antigas. Entra na MESMA fila sequencial do sync.
export async function materializeDerived(ds: {
  id: string; slug: string; tenantSlug: string; transformSql: string | null
}): Promise<string> {
  const run = (await db.query(
    `insert into sync_runs (dataset_id, mode) values ($1, 'derived') returning id`,
    [ds.id],
  )).rows[0]
  const dir = datasetDir(ds.tenantSlug, ds.slug)

  try {
    if (!ds.transformSql) throw new Error('Conjunto derivado sem SQL definido.')
    validateTransformSql(ds.transformSql)
    // Exclui o próprio slug: um derivado não referencia a si mesmo (leria a
    // versão anterior). Cadeias derivado→derivado usam os demais materializados.
    const refs = await lakeRefs(ds.tenantSlug, { excludeSlug: ds.slug })
    const wrapped = buildLakeSql(ds.transformSql, refs)

    const partFs = join(dir, `part-${run.id}.parquet`)
    const partDuck = partFs.replace(/\\/g, '/')
    try {
      await duckQuery(`copy (${wrapped}) to '${partDuck}' (format parquet, compression zstd)`)
    } catch (e) {
      throw friendlyDuckError(e as Error, refs)
    }
    clearParquet(dir, partFs)

    const fields = await refreshFields(String(ds.id), partDuck)
    const count = Number(
      (await duckQuery(`select count(*) as n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n ?? 0,
    )
    await db.query(
      `update datasets set row_count = $2, last_sync_at = now(), updated_at = now() where id = $1`,
      [ds.id, count],
    )
    await db.query(
      `update sync_runs set status = 'done', rows = $2, bytes = $3, finished_at = now() where id = $1`,
      [run.id, count, dirBytes(dir)],
    )
    await uploadToGcs(partFs, ds.tenantSlug, ds.slug)
    console.log(`[derive] ${ds.slug}: materializado, ${count} linha(s), ${fields.length} campo(s).`)
    return `ok: ${count} linha(s)`
  } catch (e) {
    await db.query(
      `update sync_runs set status = 'error', error = $2, finished_at = now() where id = $1`,
      [run.id, (e as Error).message],
    )
    throw e
  }
}
