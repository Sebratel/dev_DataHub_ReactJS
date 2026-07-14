// O "lake": diretório local de Parquet por tenant/dataset (volume em produção),
// com espelhamento opcional para o bucket GCS (durabilidade). As consultas leem
// SEMPRE o diretório local — rápido e sem custo de egress.
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs'
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

// Glob com barras normais — o DuckDB no Windows aceita e evita escape de \.
export function parquetGlob(dir: string): string {
  return join(dir, '*.parquet').replace(/\\/g, '/')
}

export function listParquet(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.parquet')).map((f) => join(dir, f))
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
