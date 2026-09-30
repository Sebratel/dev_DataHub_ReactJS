// O "lake": diretório local de Parquet por tenant/dataset (volume em produção),
// com espelhamento opcional para o bucket GCS (durabilidade). As consultas leem
// SEMPRE o diretório local — rápido e sem custo de egress.
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmSync, statfsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const LAKE_ROOT = process.env.LAKE_ROOT
  ? resolve(process.env.LAKE_ROOT)
  : resolve(__dirname, '../../../../data/lake')

export function datasetDir(tenant: string, slug: string): string {
  const dir = join(LAKE_ROOT, tenant, slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

// STAGING de ingestão: onde o JSONL temporário (que depois vira Parquet) é
// escrito. Fica no MESMO volume do lake (disco real e grande), NÃO no /tmp do
// container (pequeno) — foi o /tmp cheio que causou o ENOSPC numa carga grande.
// Configurável por SYNC_STAGING_DIR.
export function stagingDir(): string {
  const dir = process.env.SYNC_STAGING_DIR
    ? resolve(process.env.SYNC_STAGING_DIR)
    : join(LAKE_ROOT, '.staging')
  mkdirSync(dir, { recursive: true })
  return dir
}

// Remove JSONL de staging órfão (de uma carga anterior morta na marra — OOM,
// restart — em que o cleanup do finally não rodou). Chamado no BOOT, quando não
// há sync em andamento, então é sempre seguro. Impede acúmulo de dezenas de GB.
export function cleanStaging(): number {
  const dir = stagingDir()
  let n = 0
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) { unlinkSync(join(dir, f)); n++ }
  }
  return n
}

// Glob com barras normais — o DuckDB no Windows aceita e evita escape de \.
export function parquetGlob(dir: string): string {
  return join(dir, '*.parquet').replace(/\\/g, '/')
}

export function listParquet(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => join(dir, f))
}

// Apaga o diretório do conjunto no lake. Chamado ao EXCLUIR um conjunto: até
// aqui a exclusão removia só a linha no banco e deixava os Parquet no disco,
// para sempre. Dois estragos, e o segundo é pior que o vazamento:
//
//   • espaço que nunca volta — cada conjunto excluído fica ocupando disco até
//     alguém apagar à mão, e ninguém sabe que precisa;
//   • o slug vem do NOME (slugify), então recriar um conjunto com o mesmo nome
//     cai no MESMO diretório. O conjunto novo nascia enxergando os Parquet do
//     antigo, e servia esses dados até a primeira materialização limpar.
//
// Best-effort: falha aqui não pode impedir a exclusão do conjunto, que já
// aconteceu no banco. Sobra disco ocupado, que é o estado de antes.
export function removeDatasetDir(tenant: string, slug: string): boolean {
  const dir = join(LAKE_ROOT, tenant, slug)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

export function clearParquet(dir: string, except?: string): void {
  for (const f of listParquet(dir)) if (f !== except) unlinkSync(f)
}

export function dirBytes(dir: string): number {
  return listParquet(dir).reduce((sum, f) => sum + statSync(f).size, 0)
}

// Upload best-effort para o GCS (se BUCKET_GCP_NAME e credenciais existirem).
// Falha de upload NUNCA derruba o sync — o lake local continua íntegro.
export async function uploadToGcs(localFile: string, tenant: string, slug: string): Promise<void> {
  const bucketName = process.env.BUCKET_GCP_NAME
  const keyFile = process.env.PATH_CREDENTIALS
  if (!bucketName || !keyFile || !existsSync(keyFile)) return
  try {
    const { Storage } = await import('@google-cloud/storage')
    const storage = new Storage({ keyFilename: keyFile })
    const dest = `datahub/${tenant}/${slug}/${localFile.split(/[\\/]/).pop()}`
    await storage.bucket(bucketName).upload(localFile, { destination: dest })
    console.log(`[lake] espelhado no GCS: gs://${bucketName}/${dest}`)
  } catch (e) {
    console.warn(`[lake] upload GCS falhou (não-fatal): ${(e as Error).message}`)
  }
}

// ── Quanto disco o lake está usando ──────────────────────────────────────
// O servidor mostrava um "dente de serra" no gráfico de disco e a única forma
// de investigar era olhar o Grafana e correlacionar com o log de auditoria na
// mão. O hub sabe responder isso sozinho: ele é dono do volume.
//
// Três números, e os três importam por motivos diferentes:
//   • o disco do VOLUME (o que o Grafana mostra) — é o que enche;
//   • o total do LAKE — o que é dado de verdade, e que só cresce;
//   • o STAGING — transitório, mas é ele que faz o pico durante uma carga.
export interface UsoDeDisco {
  /** Do sistema de arquivos onde o lake mora. */
  totalBytes: number
  freeBytes: number
  usedPercent: number
  /** Soma dos Parquet de todos os conjuntos. */
  lakeBytes: number
  /** Arquivos temporários de carga em andamento. Zero fora de uma sincronização. */
  stagingBytes: number
  /** Os maiores conjuntos, para saber onde o espaço foi parar. */
  biggest: { tenant: string; slug: string; bytes: number }[]
}

function somaDir(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    total += f.isDirectory() ? somaDir(p) : statSync(p).size
  }
  return total
}

export function diskUsage(): UsoDeDisco {
  const fs = statfsSync(LAKE_ROOT)
  const totalBytes = fs.blocks * fs.bsize
  // bavail (e não bfree): é o que um processo sem privilégio consegue usar de
  // fato. A diferença é a reserva do sistema, e ignorá-la faz o cálculo dizer
  // que há espaço quando já não há.
  const freeBytes = fs.bavail * fs.bsize

  const conjuntos: { tenant: string; slug: string; bytes: number }[] = []
  for (const t of existsSync(LAKE_ROOT) ? readdirSync(LAKE_ROOT, { withFileTypes: true }) : []) {
    if (!t.isDirectory() || t.name.startsWith('.')) continue // .staging fora
    for (const d of readdirSync(join(LAKE_ROOT, t.name), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      conjuntos.push({ tenant: t.name, slug: d.name, bytes: somaDir(join(LAKE_ROOT, t.name, d.name)) })
    }
  }
  const lakeBytes = conjuntos.reduce((a, c) => a + c.bytes, 0)

  return {
    totalBytes, freeBytes,
    usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0,
    lakeBytes,
    stagingBytes: somaDir(stagingDir()),
    biggest: conjuntos.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  }
}
