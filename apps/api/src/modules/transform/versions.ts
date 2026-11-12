// ─────────────────────────────────────────────────────────────────────────
// Versões do SQL dos calculados (DSP-03). Ver migration 043.
//
// Toda gravação de SQL de calculado passa por recordSqlVersion: criar, editar,
// restaurar versão, materializar pelo notebook e o calculado do sistema. Gravar
// o mesmo SQL de novo não cria versão.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'

type Exec = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

// D-DSP / DSP-03: o SQL de um calculado OFICIAL só muda por admin.
export const OFICIAL_CONGELADO =
  'Conjunto oficial: o SQL está congelado. Só um administrador altera, e a versão anterior fica guardada. ' +
  'Peça a mudança a um administrador, ou crie um calculado novo a partir deste.'

/** Grava a versão nova; devolve o número dela, ou null se o SQL é igual ao da última. */
export async function recordSqlVersion(
  exec: Exec, datasetId: string, sql: string, by: string, note: string | null = null,
): Promise<number | null> {
  const ultima = (await exec.query(
    `select version, sql from dataset_sql_versions where dataset_id = $1 order by version desc limit 1`,
    [datasetId],
  )).rows[0]
  if (ultima && ultima.sql === sql) return null
  const versao = (ultima ? Number(ultima.version) : 0) + 1
  await exec.query(
    `insert into dataset_sql_versions (dataset_id, version, sql, created_by, note) values ($1, $2, $3, $4, $5)`,
    [datasetId, versao, sql, by, note],
  )
  return versao
}

export interface SqlVersion {
  version: number
  sql: string
  createdBy: string
  createdAt: string
  note: string | null
  current: boolean
}

export async function listSqlVersions(datasetId: string, currentSql: string | null): Promise<SqlVersion[]> {
  const rows = (await db.query(
    `select version, sql, created_by, created_at, note from dataset_sql_versions
      where dataset_id = $1 order by version desc`,
    [datasetId],
  )).rows
  // "Em vigor" = a mais recente com o SQL de agora (normalmente a primeira).
  const vigente = rows.find((r) => r.sql === currentSql)?.version ?? null
  return rows.map((r) => ({
    version: Number(r.version),
    sql: String(r.sql),
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    note: (r.note as string | null) ?? null,
    current: r.version === vigente,
  }))
}
