// ─────────────────────────────────────────────────────────────────────────
// Ingestão generalista fonte → lake (Parquet). Regras de carga (docs §9.1):
//   • UMA sincronização por vez em todo o hub (fila sequencial global);
//   • lotes de SYNC_BATCH_SIZE com pausa de SYNC_BATCH_PAUSE_MS entre eles;
//   • incremental por watermark (keyset — nunca OFFSET em modo incremental);
//   • SELECT simples de colunas, sem regra de negócio (guard read-only).
// O lote vai para JSONL temporário; no fim, o DuckDB converte para Parquet.
// ─────────────────────────────────────────────────────────────────────────
import { createWriteStream, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { config } from '../../core/config.js'
import { db } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { querySource } from '../../connectors/pools.js'
import { datasetDir, parquetGlob, clearParquet, dirBytes, uploadToGcs, listParquet } from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// JSON.stringify seguro para valores vindos dos drivers (BigInt, Date).
function jsonLine(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) => {
    if (typeof v === 'bigint') return v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString()
    return v
  })
}

// Fila sequencial global — dois datasets jamais sincronizam ao mesmo tempo,
// nem em fontes diferentes (prioridade absoluta: não pesar na produção).
let queue: Promise<unknown> = Promise.resolve()
export function enqueueSync(datasetId: string): Promise<string> {
  const job = queue.then(() => runSync(datasetId)).catch((e) => {
    console.error(`[sync] falha: ${(e as Error).message}`)
    return `erro: ${(e as Error).message}`
  })
  queue = job
  return job as Promise<string>
}

async function runSync(datasetId: string): Promise<string> {
  const ds = (await db.query(
    `select d.*, t.slug as tenant_slug from datasets d
      join tenants t on t.id = d.tenant_id where d.id = $1`,
    [datasetId],
  )).rows[0]
  if (!ds) throw new Error('Dataset não encontrado.')
  const def = getConnector(String(ds.connection_id))
  if (!def) throw new Error(`Fonte desconhecida: ${ds.connection_id}`)

  const mode = ds.sync_mode === 'incremental' && ds.incremental_key ? 'incremental' : 'snapshot'
  // Incremental SEM watermark = recomeço (primeira carga ou modo trocado):
  // é uma carga completa e deve SUBSTITUIR as partes antigas, não acrescentar.
  const replaceParts = mode === 'snapshot' || ds.watermark == null
  const run = (await db.query(
    `insert into sync_runs (dataset_id, mode) values ($1, $2) returning id`,
    [datasetId, mode],
  )).rows[0]

  const fields = (await db.query(
    `select source_column, key from dataset_fields where dataset_id = $1 order by sort_order`,
    [datasetId],
  )).rows
  const q = def.kind === 'mysql'
    ? (s: string) => '`' + String(s).replace(/`/g, '') + '`'
    : (s: string) => '"' + String(s).replace(/"/g, '') + '"'
  // SELECT generalista: coluna física → nome exposto (key). Nada de negócio.
  const cols = fields.map((f) => `${q(f.source_column)} as ${q(f.key)}`).join(', ')
  const from = `${q(ds.schema_name)}.${q(ds.object_name)}`

  const dir = datasetDir(String(ds.tenant_slug), String(ds.slug))
  const jsonl = join(tmpdir(), `datahub-sync-${run.id}.jsonl`)
  const stream = createWriteStream(jsonl, { encoding: 'utf8' })
  const write = (line: string) => new Promise<void>((res, rej) =>
    stream.write(line + '\n', (e) => (e ? rej(e) : res())))

  let total = 0
  let newWatermark: string | null = ds.watermark ?? null
  const { batchSize, batchPauseMs } = config.sync

  try {
    if (mode === 'incremental') {
      // Keyset por watermark: WHERE key > $wm ORDER BY key LIMIT n — nunca OFFSET.
      const keyCol = fields.find((f) => f.key === ds.incremental_key)?.source_column ?? ds.incremental_key
      for (;;) {
        const where = newWatermark != null ? `where ${q(keyCol)} > ${def.kind === 'mysql' ? '?' : '$1'}` : ''
        const sql = `select ${cols} from ${from} ${where} order by ${q(keyCol)} limit ${batchSize}`
        const { rows } = await querySource(String(ds.connection_id), sql, newWatermark != null ? [newWatermark] : [])
        for (const row of rows) await write(jsonLine(row))
        total += rows.length
        if (rows.length) {
          const last = rows[rows.length - 1][String(ds.incremental_key)]
          newWatermark = last instanceof Date ? last.toISOString() : String(last)
        }
        if (rows.length < batchSize) break
        await sleep(batchPauseMs) // respiro para a fonte entre lotes
      }
    } else {
      // Snapshot completo, paginado com pausa. (Para tabelas muito grandes,
      // configure incremental — OFFSET em páginas tardias pesa na fonte.)
      for (let offset = 0; ; offset += batchSize) {
        const sql = `select ${cols} from ${from} limit ${batchSize} offset ${offset}`
        const { rows } = await querySource(String(ds.connection_id), sql)
        for (const row of rows) await write(jsonLine(row))
        total += rows.length
        if (rows.length < batchSize) break
        await sleep(batchPauseMs)
      }
    }
    await new Promise<void>((res, rej) => stream.end((e: unknown) => (e ? rej(e) : res())))

    // JSONL → Parquet (zstd). Snapshot substitui as partes; incremental acrescenta.
    if (total > 0) {
      const part = join(dir, `part-${run.id}.parquet`).replace(/\\/g, '/')
      await duckQuery(
        `copy (select * from read_json_auto('${jsonl.replace(/\\/g, '/')}')) to '${part}' (format parquet, compression zstd)`,
      )
      if (replaceParts) clearParquet(dir, join(dir, `part-${run.id}.parquet`))
      await uploadToGcs(part, String(ds.tenant_slug), String(ds.slug))
    }

    // Contagem oficial vem do lake (fonte não é retocada).
    const count = listParquet(dir).length
      ? Number((await duckQuery(`select count(*) as n from read_parquet('${parquetGlob(dir)}')`)).rows[0]?.n ?? 0)
      : 0

    await db.query(
      `update datasets set row_count = $2, last_sync_at = now(), watermark = $3, updated_at = now() where id = $1`,
      [datasetId, count, newWatermark],
    )
    await db.query(
      `update sync_runs set status = 'done', rows = $2, bytes = $3, finished_at = now() where id = $1`,
      [run.id, total, dirBytes(dir)],
    )
    console.log(`[sync] ${ds.slug}: ${mode}, ${total} linha(s) novas, total no lake ${count}.`)
    return `ok: ${total} linha(s)`
  } catch (e) {
    await db.query(
      `update sync_runs set status = 'error', rows = $2, error = $3, finished_at = now() where id = $1`,
      [run.id, total, (e as Error).message],
    )
    throw e
  } finally {
    stream.destroy()
    if (existsSync(jsonl)) unlinkSync(jsonl)
  }
}
