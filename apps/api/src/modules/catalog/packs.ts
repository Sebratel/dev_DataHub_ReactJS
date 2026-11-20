// ─────────────────────────────────────────────────────────────────────────
// Pacotes de conjuntos: catálogo como código (pedido de 19/11/2026).
//
// Um pacote é uma lista versionada de conjuntos CALCULADOS (prata/ouro) e das
// tabelas de origem que eles leem. Instalar faz, no tenant:
//   • fonte: reaproveita o conjunto que já copia aquela tabela (pela tabela,
//     não pelo nome — os nomes de hoje variam); se não houver, publica um
//     bronze no padrão de nomes SÓ com as colunas que o pacote usa (a carga
//     fica leve) e aplica a regra de carga do pacote;
//   • calculado: cria com o nome do pacote, em cascata (recalcula quando a
//     fonte termina de carregar) — nenhum relógio a mais na fila.
// Instalar de novo é seguro: o que já existe fica como está.
//
// O SQL cita a fonte por {{sistema.tabela}} (ex.: {{voalle.contracts}}) e o
// instalador troca pelo nome do conjunto que copia aquela tabela.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { discoverColumns } from '../../connectors/pools.js'
import { applySyncConfig, type SyncConfigInput } from '../sync/syncConfig.js'
import { enqueueSync } from '../sync/ingest.js'
import { validateTransformSql, assertSafeLakeSql, type LakeRef } from '../transform/derive.js'
import { recordSqlVersion } from '../transform/versions.js'
import { novoNome, segueOPadrao } from './naming.js'
import { currentSlugFor } from '../../core/slugAliases.js'
import type { RenameUser } from './naming.js'
import { ONDA_1 } from './packs/onda1.js'
import { ONDA_2 } from './packs/onda2.js'

export interface PackSource {
  /** Como o SQL cita: {{voalle.contracts}}. */
  ref: string
  system: 'voalle'
  schema: string
  table: string
  name: string
  description: string
  /** Só estas colunas entram na cópia — o resto da tabela não é lido. */
  columns: string[]
  sync: SyncConfigInput
}

export interface PackDataset {
  slug: string
  name: string
  description: string
  domain: string
  sql: string
}

export interface PackNotebookCell {
  kind: 'sql' | 'python' | 'markdown'
  source: string
}

/** Notebook pronto: SQL agrega os conjuntos do pacote, Python modela (item 6). */
export interface PackNotebook {
  slug: string
  name: string
  description: string
  domain: string
  cells: PackNotebookCell[]
}

export interface Pack {
  id: string
  name: string
  description: string
  sources: PackSource[]
  datasets: PackDataset[]
  notebooks?: PackNotebook[]
}

// Notebook segue o mesmo snake_case dos conjuntos, sem a camada: analise_<área>_<assunto>.
const NOME_NOTEBOOK = /^[a-z0-9]+(_[a-z0-9]+)+$/

/** Os conjuntos do pacote que as células SQL de um notebook citam. */
export function conjuntosDoNotebook(nb: PackNotebook, slugs: string[]): string[] {
  const sql = nb.cells.filter((c) => c.kind === 'sql').map((c) => c.source).join('\n')
  return slugs.filter((s) => new RegExp(`\\b${s}\\b`).test(sql))
}

export const PACKS: Pack[] = [ONDA_1, ONDA_2]

export class PackError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const REF = /\{\{([a-z0-9_]+\.[a-z0-9_]+)\}\}/g

/** As fontes que um SQL do pacote cita. */
export function refsDoSql(sql: string): string[] {
  return [...new Set([...sql.matchAll(REF)].map((m) => m[1]))]
}

export function resolveSql(sql: string, slugs: Map<string, string>): string {
  return sql.replace(REF, (_, ref: string) => {
    const s = slugs.get(ref)
    if (!s) throw new Error(`Fonte ${ref} não resolvida.`)
    return s
  })
}

function mapType(dataType: string): string {
  const dt = dataType.toLowerCase()
  if (/int|numeric|decimal|double|real|float|money/.test(dt)) return 'number'
  if (/bool/.test(dt)) return 'bool'
  if (/timestamp|datetime|date/.test(dt)) return 'date'
  if (/json/.test(dt)) return 'json'
  return 'text'
}

const labelize = (c: string) => c.replace(/[_-]+/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase())

async function tenantIdDe(tenantSlug: string): Promise<string> {
  const t = (await db.query('select id from tenants where slug = $1', [tenantSlug])).rows[0]
  if (!t) throw new PackError(404, 'Tenant não encontrado.')
  return String(t.id)
}

/**
 * A conexão que lê o Voalle: a que já copia mais tabelas do schema erp; sem
 * nenhuma, a fonte embutida do ambiente (DB_ELLEVEN_*).
 */
async function conexaoDoSistema(tenantId: string, schema: string, pedida?: string | null): Promise<string> {
  if (pedida) {
    if (!getConnector(pedida)) throw new PackError(400, `Conexão desconhecida: ${pedida}`)
    return pedida
  }
  const r = (await db.query(
    `select connection_id, count(*) as n from datasets
      where tenant_id = $1 and kind = 'source' and schema_name = $2
      group by connection_id order by count(*) desc`, [tenantId, schema],
  )).rows.find((x) => getConnector(String(x.connection_id)))
  if (r) return String(r.connection_id)
  if (getConnector('elleven')) return 'elleven'
  throw new PackError(400, 'Nenhuma conexão com o Voalle. Cadastre a conexão ou informe qual usar.')
}

interface FonteExistente { id: string; slug: string; colunas: Set<string> }

async function fonteExistente(tenantId: string, s: PackSource): Promise<FonteExistente | null> {
  const ds = (await db.query(
    `select id, slug from datasets
      where tenant_id = $1 and kind = 'source' and schema_name = $2 and object_name = $3
      order by created_at limit 1`, [tenantId, s.schema, s.table],
  )).rows[0]
  if (!ds) return null
  const colunas = new Set((await db.query(
    'select source_column from dataset_fields where dataset_id = $1', [ds.id],
  )).rows.map((r) => String(r.source_column)))
  return { id: String(ds.id), slug: String(ds.slug), colunas }
}

async function slugExistente(tenantId: string, slug: string): Promise<string | null> {
  const r = (await db.query('select slug from datasets where tenant_id = $1 and slug = $2', [tenantId, slug])).rows[0]
  if (r) return String(r.slug)
  return currentSlugFor(slug)
}

// ── Situação de um pacote no tenant ──────────────────────────────────────
export interface PackStatus {
  id: string; name: string; description: string
  sources: { ref: string; name: string; slug: string | null; faltam: string[] }[]
  datasets: { slug: string; name: string; domain: string; description: string; instalado: boolean; rowCount: number | null; lastSyncAt: string | null }[]
  notebooks: { slug: string; name: string; domain: string; description: string; instalado: boolean; usa: string[] }[]
}

async function notebookExiste(tenantId: string, slug: string): Promise<boolean> {
  return ((await db.query('select 1 from notebooks where tenant_id = $1 and slug = $2', [tenantId, slug])).rowCount ?? 0) > 0
}

export async function packStatus(tenantSlug: string, pack: Pack): Promise<PackStatus> {
  const tenantId = await tenantIdDe(tenantSlug)
  const sources = []
  for (const s of pack.sources) {
    const f = await fonteExistente(tenantId, s)
    sources.push({ ref: s.ref, name: s.name, slug: f?.slug ?? null, faltam: f ? s.columns.filter((c) => !f.colunas.has(c)) : [] })
  }
  const datasets = []
  for (const d of pack.datasets) {
    const atual = await slugExistente(tenantId, d.slug)
    const row = atual ? (await db.query(
      'select row_count, last_sync_at from datasets where tenant_id = $1 and slug = $2', [tenantId, atual],
    )).rows[0] : null
    datasets.push({
      slug: atual ?? d.slug, name: d.name, domain: d.domain, description: d.description, instalado: !!atual,
      rowCount: row?.row_count == null ? null : Number(row.row_count),
      lastSyncAt: row?.last_sync_at ? new Date(row.last_sync_at as string).toISOString() : null,
    })
  }
  const slugsDoPacote = pack.datasets.map((d) => d.slug)
  const notebooks = []
  for (const nb of pack.notebooks ?? []) {
    notebooks.push({
      slug: nb.slug, name: nb.name, domain: nb.domain, description: nb.description,
      instalado: await notebookExiste(tenantId, nb.slug), usa: conjuntosDoNotebook(nb, slugsDoPacote),
    })
  }
  return { id: pack.id, name: pack.name, description: pack.description, sources, datasets, notebooks }
}

// ── Instalar ──────────────────────────────────────────────────────────────
export interface InstallReport {
  connectionId: string
  sources: { ref: string; slug: string | null; status: 'reaproveitada' | 'criada' | 'incompleta' | 'erro'; detail?: string }[]
  datasets: { slug: string; status: 'criado' | 'ja-existe' | 'pulado' | 'erro'; detail?: string }[]
  notebooks: { slug: string; status: 'criado' | 'ja-existe' | 'pulado' | 'erro'; detail?: string }[]
}

export async function installPack(
  user: RenameUser & { email: string }, pack: Pack, opts: { connectionId?: string | null } = {},
): Promise<InstallReport> {
  // Publicar FONTE é do master (D-DSP-3), e instalar publica fonte.
  if (!user.master) throw new PackError(403, 'Instalar pacote publica fontes: só um admin master instala.')
  const tenantId = await tenantIdDe(user.tenant)
  const connectionId = await conexaoDoSistema(tenantId, pack.sources[0]?.schema ?? 'erp', opts.connectionId)
  const report: InstallReport = { connectionId, sources: [], datasets: [], notebooks: [] }
  const resolvidas = new Map<string, string>()
  // Fontes novas só entram na fila no FIM, depois que os calculados existem.
  // A cascata procura os dependentes no instante em que a carga termina: uma
  // fonte pequena enfileirada aqui terminava antes de os calculados serem
  // gravados, a cascata não achava ninguém e o calculado nunca rodava (no CI
  // de 20/11, o prata_voalle_contratos e os 20 ouro que dependem dele).
  const paraCarregar: string[] = []

  for (const s of pack.sources) {
    try {
      const ja = await fonteExistente(tenantId, s)
      if (ja) {
        const faltam = s.columns.filter((c) => !ja.colunas.has(c))
        if (faltam.length) {
          // Não mexe em conjunto alheio: coluna nova num incremental deixaria
          // as partes antigas sem ela. Quem decide é o admin, na tela do conjunto.
          report.sources.push({
            ref: s.ref, slug: ja.slug, status: 'incompleta',
            detail: `faltam as colunas ${faltam.join(', ')} — publique-as em "Atualizar colunas" e recarregue`,
          })
          continue
        }
        resolvidas.set(s.ref, ja.slug)
        report.sources.push({ ref: s.ref, slug: ja.slug, status: 'reaproveitada' })
        continue
      }
      const naFonte = await discoverColumns(connectionId, s.schema, s.table)
      const tipo = new Map(naFonte.map((c) => [c.name, c.dataType]))
      const faltam = s.columns.filter((c) => !tipo.has(c))
      if (!naFonte.length || faltam.length) {
        report.sources.push({
          ref: s.ref, slug: null, status: 'erro',
          detail: naFonte.length ? `a tabela não tem: ${faltam.join(', ')}` : 'tabela não encontrada na fonte',
        })
        continue
      }
      const slug = await novoNome(db, tenantId, { camada: 'bronze', area: s.system, nome: s.table })
      const ds = (await db.query(
        `insert into datasets (tenant_id, connection_id, schema_name, object_name, slug, name, description, owner_email)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [tenantId, connectionId, s.schema, s.table, slug, s.name, s.description, user.email],
      )).rows[0]
      for (const [i, c] of s.columns.entries()) {
        await db.query(
          `insert into dataset_fields (dataset_id, source_column, key, label, type, sort_order)
           values ($1, $2, $3, $4, $5, $6)`,
          [ds.id, c, c, labelize(c), mapType(tipo.get(c)!), i],
        )
      }
      await applySyncConfig(String(ds.id), s.sync)
      paraCarregar.push(String(ds.id))
      resolvidas.set(s.ref, slug)
      report.sources.push({ ref: s.ref, slug, status: 'criada' })
    } catch (e) {
      report.sources.push({ ref: s.ref, slug: null, status: 'erro', detail: (e as Error).message })
    }
  }

  // Nomes que o SQL pode citar: o catálogo de hoje mais o que este pacote cria.
  const catalogo = (await db.query('select slug from datasets where tenant_id = $1', [tenantId])).rows.map((r) => String(r.slug))
  const citaveis: LakeRef[] = [...new Set([...catalogo, ...pack.datasets.map((d) => d.slug)])].map((slug) => ({ slug, glob: '' }))

  for (const d of pack.datasets) {
    try {
      if (!segueOPadrao(d.slug)) throw new Error('nome fora do padrão (erro do pacote)')
      if (await slugExistente(tenantId, d.slug)) {
        report.datasets.push({ slug: d.slug, status: 'ja-existe' })
        continue
      }
      const faltando = refsDoSql(d.sql).filter((r) => !resolvidas.has(r))
      if (faltando.length) {
        report.datasets.push({ slug: d.slug, status: 'pulado', detail: `fonte indisponível: ${faltando.join(', ')}` })
        continue
      }
      const sql = resolveSql(d.sql, resolvidas)
      validateTransformSql(sql)
      await assertSafeLakeSql(sql, citaveis) // gramática e nomes; os dados chegam com a carga
      const ds = (await db.query(
        `insert into datasets (tenant_id, kind, transform_sql, connection_id, schema_name, object_name,
                               slug, name, description, tags, sync_mode, sync_cadence, owner_email)
         values ($1, 'derived', $2, 'lake', 'derived', $3, $3, $4, $5, $6, 'snapshot', 'cascade', $7)
         returning id`,
        [tenantId, sql, d.slug, d.name, d.description, [pack.id, d.domain], user.email],
      )).rows[0]
      await recordSqlVersion(db, String(ds.id), sql, user.email, `Instalado pelo pacote ${pack.id}.`)
      report.datasets.push({ slug: d.slug, status: 'criado' })
    } catch (e) {
      report.datasets.push({ slug: d.slug, status: 'erro', detail: (e as Error).message })
    }
  }

  // Fonte reaproveitada não vai carregar de novo tão cedo: dispara os
  // calculados que só dependem dela, sem esperar a próxima carga.
  const reaproveitadas = report.sources.filter((s) => s.status === 'reaproveitada').map((s) => s.slug)
  const novos = report.datasets.filter((d) => d.status === 'criado').map((d) => d.slug)
  if (reaproveitadas.length && novos.length) {
    for (const r of (await db.query(
      `select id, slug, transform_sql from datasets where tenant_id = $1 and kind = 'derived'`, [tenantId],
    )).rows) {
      if (!novos.includes(String(r.slug))) continue
      const deps = pack.datasets.find((d) => d.slug === r.slug)!
      const fontes = refsDoSql(deps.sql)
      if (fontes.length && fontes.every((f) => reaproveitadas.includes(resolvidas.get(f)!))) void enqueueSync(String(r.id))
    }
  }
  // Notebooks prontos: nascem privados, no nome de quem instalou, como os
  // conjuntos — quem libera para as áreas é o admin, em "Acessos". Só entra o
  // notebook cujos conjuntos existem; os dados chegam com a carga.
  const slugsDoPacote = pack.datasets.map((d) => d.slug)
  for (const nb of pack.notebooks ?? []) {
    try {
      if (!NOME_NOTEBOOK.test(nb.slug)) throw new Error('nome fora do padrão (erro do pacote)')
      if (await notebookExiste(tenantId, nb.slug)) {
        report.notebooks.push({ slug: nb.slug, status: 'ja-existe' })
        continue
      }
      const faltam: string[] = []
      for (const s of conjuntosDoNotebook(nb, slugsDoPacote)) {
        if (!(await slugExistente(tenantId, s))) faltam.push(s)
      }
      if (faltam.length) {
        report.notebooks.push({ slug: nb.slug, status: 'pulado', detail: `falta o conjunto ${faltam.join(', ')}` })
        continue
      }
      const cells = nb.cells.map((c, i) => ({ id: `c${i + 1}`, kind: c.kind, source: c.source }))
      await db.query(
        `insert into notebooks (tenant_id, slug, name, description, cells, visibility, owner_email)
         values ($1, $2, $3, $4, $5, 'private', $6)`,
        [tenantId, nb.slug, nb.name, nb.description, JSON.stringify(cells), user.email],
      )
      report.notebooks.push({ slug: nb.slug, status: 'criado' })
    } catch (e) {
      report.notebooks.push({ slug: nb.slug, status: 'erro', detail: (e as Error).message })
    }
  }

  // Primeira carga das fontes novas, em segundo plano e pela fila de sempre.
  // Os calculados já estão gravados, então a cascata de cada uma os encontra.
  for (const id of paraCarregar) void enqueueSync(id)
  return report
}

export function packById(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id)
}
