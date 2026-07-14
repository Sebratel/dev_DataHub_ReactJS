// DuckDB embutido — motor de consulta do lake. Instância única em memória;
// cada consulta usa uma conexão própria (barato) para evitar interferência.
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'

let instance: DuckDBInstance | null = null

async function getInstance(): Promise<DuckDBInstance> {
  if (!instance) instance = await DuckDBInstance.create(':memory:')
  return instance
}

export interface DuckResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

export async function duckQuery(sql: string, params: unknown[] = []): Promise<DuckResult> {
  const conn: DuckDBConnection = await (await getInstance()).connect()
  try {
    // getRowObjectsJson() converte BIGINT/DATE/TIMESTAMP para valores JSON-safe.
    const reader = await conn.runAndReadAll(sql, params as never[])
    return {
      columns: reader.columnNames(),
      rows: reader.getRowObjectsJson() as Record<string, unknown>[],
    }
  } finally {
    conn.closeSync()
  }
}
