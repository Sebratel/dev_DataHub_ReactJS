// Manifesto do envio — o sinal de "terminei" para o job de carga.
//
// Ele é enviado DEPOIS dos Parquet, e é isso que torna o envio seguro sem
// transação: o job só olha um conjunto quando o manifesto aparece, então um
// envio interrompido no meio deixa Parquet órfão (inofensivo, limpo pela
// retenção) em vez de carregar meia tabela.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { statSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ColunaConsolidada } from './consolidate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Em streaming: o arquivo pode ter centenas de MB e não cabe tudo em memória. */
export function sha256Arquivo(caminho: string): Promise<string> {
  return new Promise((ok, erro) => {
    const hash = createHash('sha256')
    createReadStream(caminho)
      .on('data', (c) => hash.update(c))
      .on('error', erro)
      .on('end', () => ok(hash.digest('hex')))
  })
}

export function versaoDoHub(): string {
  try {
    const pkg = readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
    return (JSON.parse(pkg) as { version?: string }).version ?? 'desconhecida'
  } catch {
    return 'desconhecida'
  }
}

export interface ArquivoManifesto { path: string; size_bytes: number; sha256: string }

export interface Manifesto {
  run_id: string
  dataset_slug: string
  layer: string
  source_connection: string
  mode: string
  dedupe_keys: string[]
  source_parts: number
  row_count: number
  compression: 'zstd'
  timestamps: { stored_as: 'UTC'; source_timezone: string }
  files: ArquivoManifesto[]
  columns: Array<{ name: string; type: string; nullable: boolean }>
  /** Só aparece quando a normalização mudou algum nome (seção 5 do spec). */
  renamed_columns?: Array<{ from: string; to: string }>
  /** Só aparece quando o conjunto não tem dedupe_keys. */
  warning?: string
  extracted_at: string
  published_at: string
  datahub_version: string
}

// O tipo do DuckDB não é o do Spark. A tradução aqui é só informativa — quem
// decide o tipo final é o Parquet, que o Spark lê sozinho. Ela existe para o
// manifesto ser legível por gente.
function tipoLegivel(duckType: string): string {
  const t = duckType.toUpperCase()
  if (t.startsWith('TIMESTAMP')) return 'timestamp'
  if (t === 'DATE') return 'date'
  if (t === 'BIGINT' || t === 'HUGEINT') return 'bigint'
  if (t === 'INTEGER' || t === 'SMALLINT' || t === 'TINYINT') return 'int'
  if (t === 'DOUBLE' || t === 'FLOAT' || t === 'REAL') return 'double'
  if (t.startsWith('DECIMAL')) return t.toLowerCase()
  if (t === 'BOOLEAN') return 'boolean'
  return 'string'
}

export interface MontarManifestoArgs {
  runId: string
  slug: string
  layer: string
  sourceConnection: string
  mode: string
  dedupeKeys: string[]
  sourceParts: number
  rowCount: number
  columns: ColunaConsolidada[]
  renamed: Array<{ from: string; to: string }>
  warning?: string
  sourceTimezone: string
  /** Caminho local → caminho no volume. */
  arquivos: Array<{ local: string; volume: string }>
  extractedAt: Date
}

export async function montarManifesto(a: MontarManifestoArgs): Promise<Manifesto> {
  const files: ArquivoManifesto[] = []
  for (const f of a.arquivos) {
    files.push({
      path: f.volume,
      size_bytes: statSync(f.local).size,
      sha256: await sha256Arquivo(f.local),
    })
  }
  return {
    run_id: a.runId,
    dataset_slug: a.slug,
    layer: a.layer,
    source_connection: a.sourceConnection,
    mode: a.mode,
    dedupe_keys: a.dedupeKeys,
    source_parts: a.sourceParts,
    row_count: a.rowCount,
    compression: 'zstd',
    timestamps: { stored_as: 'UTC', source_timezone: a.sourceTimezone },
    files,
    columns: a.columns.map((c) => ({
      name: c.name, type: tipoLegivel(c.type), nullable: c.nullable,
    })),
    ...(a.renamed.length ? { renamed_columns: a.renamed } : {}),
    ...(a.warning ? { warning: a.warning } : {}),
    extracted_at: a.extractedAt.toISOString(),
    published_at: new Date().toISOString(),
    datahub_version: versaoDoHub(),
  }
}
