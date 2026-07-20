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

// Conjuntos-FONTE do tenant que já têm Parquet no lake (derivados não entram:
// evita cadeias com ordem de atualização imprevisível — v1 é fonte → derivado).
export async function lakeRefs(tenantSlug: string): Promise<LakeRef[]> {
  const rows = (await db.query(
    `select d.slug from datasets d join tenants t on t.id = d.tenant_id
      where t.slug = $1 and d.kind = 'source'`,
    [tenantSlug],
  )).rows
  const refs: LakeRef[] = []
  for (const r of rows) {
    const dir = datasetDir(tenantSlug, String(r.slug))
    if (listParquet(dir).length) refs.push({ slug: String(r.slug), glob: parquetGlob(dir) })
  }
  return refs
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
    '(2) é um conjunto FONTE já sincronizado (derivados não podem ser referenciados nesta versão); ' +
    '(3) a sincronização realmente rodou (metadado pode indicar sync sem os arquivos no lake — re-sincronize). ' +
    `Disponíveis agora: ${available || 'nenhum'}.`,
  )
}

// Amostra do resultado (LIMIT 50) — validação/preview antes de criar/salvar.
export async function previewDerived(
  tenantSlug: string, sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  validateTransformSql(sql)
  const refs = await lakeRefs(tenantSlug)
  const wrapped = buildLakeSql(sql, refs)
  try {
    const res = await duckQuery(`select * from (${wrapped}) as __p limit 50`, [], { timeoutMs: config.duck.queryTimeoutMs })
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
    const refs = await lakeRefs(ds.tenantSlug)
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
