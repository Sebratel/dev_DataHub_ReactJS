// ─────────────────────────────────────────────────────────────────────────
// Padrão de nomes dos conjuntos (pedido de 19/11/2026).
//
//   <camada>_<área>_<assunto>[_<período>]     minúsculas, palavras com "_"
//   ex.: bronze_voalle_contratos · prata_cancelamentos_mensal · ouro_financeiro_titulos_abertos_diario
//
// Por que sublinhado e não traço: é o que Databricks, Snowflake, BigQuery e dbt
// usam, porque traço não é identificador SQL — "contratos-ativos" só funciona
// entre aspas. A camada abre o nome (bronze = cópia da fonte, prata = tratado,
// ouro = pronto para a área) e a área diz de onde vem (voalle, autoisp…) ou de
// que assunto é (financeiro, cancelamento…).
//
// Conjunto novo já nasce no padrão. Os antigos passam pela tela "Padronizar
// nomes", que sugere o nome e renomeia um a um; o nome antigo vira APELIDO
// (core/slugAliases.ts) e nada que o usa quebra.
// ─────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../../db/pool.js'
import { LAKE_ROOT } from '../../core/lake.js'
import { getConnector } from '../../connectors/registry.js'
import { loadSlugAliases } from '../../core/slugAliases.js'
import { syncQueueState } from '../sync/ingest.js'
import type { AccessUser } from '../../core/access.js'

export const CAMADAS = ['bronze', 'prata', 'ouro'] as const
export type Camada = typeof CAMADAS[number]

/** Camada + pelo menos uma palavra; só minúsculas, dígitos e "_" entre palavras. */
export const PADRAO_NOME = /^(bronze|prata|ouro)(_[a-z0-9]+)+$/
export const NOME_MAX = 80

type Consulta = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }

/** "Contratos Ativos (2024)" → "contratos_ativos_2024". */
export function snake(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function segueOPadrao(slug: string): boolean {
  return slug.length <= NOME_MAX && PADRAO_NOME.test(slug)
}

export function camadaDoNome(slug: string): Camada | null {
  const m = /^(bronze|prata|ouro)_/.exec(slug)
  return m ? (m[1] as Camada) : null
}

// Nome curto de cada fonte embutida. As cadastradas na tela usam o próprio
// nome; o servidor MariaDB tem vários bancos, e o banco diz mais que o servidor.
const AREA_EMBUTIDA: Record<string, string> = {
  elleven: 'voalle', autoisp: 'autoisp', radius: 'radius', 'datahub-meta': 'datahub',
}

export function areaDaFonte(connectionId: string, schema?: string | null): string {
  if (AREA_EMBUTIDA[connectionId]) return AREA_EMBUTIDA[connectionId]
  if (connectionId === 'maria' && schema) return snake(schema).replace(/^db_/, '').slice(0, 30) || 'mariadb'
  return snake(getConnector(connectionId)?.name ?? connectionId).slice(0, 30).replace(/_+$/, '') || 'fonte'
}

/** Monta o nome no padrão. Nome que já começa por uma camada é respeitado. */
export function nomePadrao(p: { camada: Camada; area?: string | null; nome: string }): string {
  let nome = snake(p.nome) || 'conjunto'
  if (!camadaDoNome(nome)) {
    const area = p.area ? snake(p.area) : ''
    const partes: string[] = [p.camada]
    if (area && nome !== area && !nome.startsWith(`${area}_`)) partes.push(area)
    partes.push(nome)
    nome = partes.join('_')
  }
  return nome.slice(0, NOME_MAX).replace(/_+$/, '')
}

/** Sufixo de desempate no mesmo estilo do nome: _2 no padrão, -2 nos antigos. */
export function comSufixo(base: string, i: number): string {
  return /^[a-z0-9_]+$/.test(base) ? `${base}_${i}` : `${base}-${i}`
}

/**
 * Nomes que um conjunto novo (ou renomeado) não pode usar: os atuais, os
 * apelidos, e a forma com sublinhado de cada um — no SQL, "a-b" também
 * responde por a_b, e dois conjuntos com o mesmo apelido seriam ambíguos.
 */
export async function nomesOcupados(q: Consulta, tenantId: string, exceto?: string): Promise<Set<string>> {
  const atuais = (await q.query(
    'select id, slug from datasets where tenant_id = $1', [tenantId],
  )).rows.filter((r) => String(r.id) !== exceto).map((r) => String(r.slug))
  const apelidos = (await q.query(
    'select old_slug, dataset_id from dataset_slug_aliases where tenant_id = $1', [tenantId],
  )).rows.filter((r) => String(r.dataset_id) !== exceto).map((r) => String(r.old_slug))
  const todos = [...atuais, ...apelidos]
  return new Set([...todos, ...todos.map((s) => s.replace(/-/g, '_'))])
}

export function nomeLivre(base: string, ocupados: Set<string>): string {
  let nome = base
  for (let i = 2; ocupados.has(nome) || ocupados.has(nome.replace(/-/g, '_')); i++) nome = comSufixo(base, i)
  return nome
}

/** Nome livre no padrão para um conjunto novo. */
export async function novoNome(q: Consulta, tenantId: string, p: Parameters<typeof nomePadrao>[0]): Promise<string> {
  return nomeLivre(nomePadrao(p), await nomesOcupados(q, tenantId))
}

// ── Sugestão para os conjuntos que já existem ─────────────────────────────
interface LinhaNome {
  id: string; slug: string; name: string; kind: string; official: boolean
  connection_id: string; schema_name: string; databricks_layer: string | null
}

function sugestaoBase(d: LinhaNome): string {
  const derivado = d.kind === 'derived'
  const camada = (d.databricks_layer as Camada | null) ?? (derivado ? 'prata' : 'bronze')
  return nomePadrao({
    camada,
    area: derivado ? null : areaDaFonte(d.connection_id, d.schema_name),
    nome: d.slug,
  })
}

export interface ItemNome {
  id: string; slug: string; name: string; kind: 'source' | 'derived'; official: boolean
  conforme: boolean; sugestao: string | null; apelidos: string[]
}

export async function listaNomes(tenantSlug: string): Promise<ItemNome[]> {
  const tenant = (await db.query('select id from tenants where slug = $1', [tenantSlug])).rows[0]
  if (!tenant) return []
  const rows = (await db.query(
    `select id, slug, name, kind, official, connection_id, schema_name, databricks_layer
       from datasets where tenant_id = $1 order by name`, [tenant.id],
  )).rows as unknown as LinhaNome[]
  const apelidos = (await db.query(
    'select old_slug, dataset_id from dataset_slug_aliases where tenant_id = $1 order by created_at', [tenant.id],
  )).rows
  const ocupados = await nomesOcupados(db, String(tenant.id))
  return rows.map((d) => {
    const conforme = segueOPadrao(d.slug)
    let sugestao: string | null = null
    if (!conforme) {
      // A sugestão de um conjunto não pode colidir com a de outro da lista.
      const livres = new Set(ocupados)
      for (const n of [d.slug, ...apelidos.filter((a) => String(a.dataset_id) === String(d.id)).map((a) => String(a.old_slug))]) {
        livres.delete(n); livres.delete(n.replace(/-/g, '_'))
      }
      sugestao = nomeLivre(sugestaoBase(d), livres)
      ocupados.add(sugestao)
    }
    return {
      id: String(d.id), slug: String(d.slug), name: String(d.name),
      kind: d.kind === 'derived' ? 'derived' : 'source', official: !!d.official,
      conforme, sugestao,
      apelidos: apelidos.filter((a) => String(a.dataset_id) === String(d.id)).map((a) => String(a.old_slug)),
    }
  })
}

// ── Renomear ──────────────────────────────────────────────────────────────
export class NamingError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface RenameUser extends AccessUser { master?: boolean }

/**
 * Troca o nome de um conjunto. Numa transação: o nome, o apelido do nome
 * antigo e as referências GRAVADAS por nome (escopo de token, API do
 * construtor, modelo, filtro de aba de painel). SQL salvo não é reescrito —
 * o apelido o mantém funcionando. A pasta do lake muda junto; se a troca da
 * pasta falhar, nada muda.
 */
export async function renameDataset(user: RenameUser, datasetId: string, pedido: string): Promise<{ from: string; to: string }> {
  const novo = String(pedido ?? '').trim().toLowerCase()
  const ds = (await db.query(
    `select d.id, d.slug, d.kind, d.official, d.tenant_id from datasets d
       join tenants t on t.id = d.tenant_id where t.slug = $1 and d.id = $2`,
    [user.tenant, datasetId],
  )).rows[0]
  if (!ds) throw new NamingError(404, 'Conjunto de dados não encontrado.')
  // Mesmo critério da lixeira (D-DSP-3): o oficial é contrato com quem o usa.
  if (ds.official && !user.master) throw new NamingError(403, 'Conjunto oficial: só um admin master renomeia.')
  const antigo = String(ds.slug)
  if (novo === antigo) throw new NamingError(400, 'O conjunto já tem esse nome.')
  if (!segueOPadrao(novo)) {
    throw new NamingError(400,
      `Nome fora do padrão: use <camada>_<área>_<assunto>, em minúsculas e com "_" entre as palavras ` +
      `(camada: bronze, prata ou ouro; até ${NOME_MAX} caracteres). Ex.: bronze_voalle_contratos.`)
  }
  const tenantId = String(ds.tenant_id)
  const ocupados = await nomesOcupados(db, tenantId, String(ds.id))
  if (ocupados.has(novo)) throw new NamingError(409, `O nome "${novo}" já é de outro conjunto (ou foi, e ficou como apelido).`)
  if (syncQueueState(String(ds.id)).state !== 'idle') {
    throw new NamingError(409, 'O conjunto está atualizando ou na fila. Espere a carga terminar e renomeie de novo.')
  }

  const origem = join(LAKE_ROOT, user.tenant, antigo)
  const destino = join(LAKE_ROOT, user.tenant, novo)
  if (existsSync(destino) && readdirSync(destino).length) {
    throw new NamingError(409, `Já existe uma pasta "${novo}" no lake com arquivos. Avise o suporte antes de usar esse nome.`)
  }

  const client = await db.connect()
  let moveu = false
  try {
    await client.query('begin')
    await client.query(
      `update datasets set slug = $2,
              object_name = case when kind = 'derived' then $2 else object_name end,
              databricks_layer = $3, updated_at = now()
        where id = $1`,
      [ds.id, novo, camadaDoNome(novo)],
    )
    // Voltar a um nome antigo DESTE conjunto: o apelido dá lugar ao nome.
    await client.query('delete from dataset_slug_aliases where tenant_id = $1 and old_slug = $2', [tenantId, novo])
    await client.query(
      'insert into dataset_slug_aliases (tenant_id, old_slug, dataset_id) values ($1, $2, $3)',
      [tenantId, antigo, ds.id],
    )
    // Escopo de token: a lista de conjuntos é por nome.
    for (const c of (await client.query(
      'select id, dataset_slugs from api_credentials where tenant_id = $1', [tenantId],
    )).rows) {
      const lista = (Array.isArray(c.dataset_slugs) ? c.dataset_slugs : []) as string[]
      if (lista.includes(antigo)) {
        await client.query('update api_credentials set dataset_slugs = $2 where id = $1',
          [c.id, lista.map((s) => (s === antigo ? novo : s))])
      }
    }
    await client.query('update api_products set dataset_slug = $3 where tenant_id = $1 and dataset_slug = $2', [tenantId, antigo, novo])
    await client.query('update ml_models set dataset_slug = $3 where tenant_id = $1 and dataset_slug = $2', [tenantId, antigo, novo])
    // Filtro de aba: vale para os gráficos do MESMO conjunto, comparados por nome.
    for (const t of (await client.query(
      `select dt.id, dt.config from dashboard_tabs dt join dashboards d on d.id = dt.dashboard_id
        where d.tenant_id = $1 and dt.config is not null`, [tenantId],
    )).rows) {
      const cfg = (typeof t.config === 'string' ? JSON.parse(t.config) : t.config) as { filters?: Array<{ datasetSlug?: string }> } | null
      if (!cfg?.filters?.some((f) => f.datasetSlug === antigo)) continue
      cfg.filters = cfg.filters.map((f) => (f.datasetSlug === antigo ? { ...f, datasetSlug: novo } : f))
      await client.query('update dashboard_tabs set config = $2::jsonb where id = $1', [t.id, JSON.stringify(cfg)])
    }
    // A pasta muda por último e DENTRO da transação: se falhar, nada muda.
    if (existsSync(origem)) {
      if (existsSync(destino)) rmdirSync(destino) // vazia (conferido acima): uma leitura do nome a criou
      renameSync(origem, destino)
      moveu = true
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => { /* conexão já perdida */ })
    if (moveu) {
      try { renameSync(destino, origem) } catch (e2) {
        console.error(`[nomes] pasta de "${antigo}" ficou em "${novo}" após falha: ${(e2 as Error).message}`)
      }
    }
    throw e
  } finally {
    client.release()
  }
  await loadSlugAliases()
  return { from: antigo, to: novo }
}
