// O "lake": diretório local de Parquet por tenant/dataset (volume em produção),
// com espelhamento opcional para o bucket GCS (durabilidade). As consultas leem
// SEMPRE o diretório local — rápido e sem custo de egress.
import {
  mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmSync, statfsSync,
  renameSync, openSync, readSync, closeSync,
} from 'node:fs'
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

// ── Parte EM ESCRITA ─────────────────────────────────────────────────────
// O `COPY ... TO` do DuckDB escrevia direto com o nome final, dentro da pasta
// do conjunto. Interrompido no meio — servidor reiniciado, disco cheio, erro
// depois do arquivo já criado — ele deixava um "part-xxx.parquet" truncado, e
// o `catch` só marcava a execução como erro: ninguém removia o arquivo.
//
// A partir daí o conjunto ficava ENVENENADO. `read_parquet(pasta/*.parquet)`
// lê TODOS os arquivos, então um inválido derruba a leitura inteira — o
// próprio conjunto, todo calculado que o referencia e todo painel que o usa,
// com a mensagem "File ... too small to be a Parquet file", que não diz nem
// qual conjunto nem o que fazer. Aconteceu em produção.
//
// O sufixo abaixo NÃO termina em .parquet, então nenhum glob o enxerga: uma
// escrita interrompida deixa lixo invisível em vez de veneno. A parte só
// ganha o nome final depois do COPY voltar, por rename (atômico no mesmo
// volume).
export const SUFIXO_EM_ESCRITA = '.writing'

// Os QUATRO caminhos vêm prontos, e com nome dizendo qual é qual, porque
// confundi-los já custou caro: trocar o destino do COPY para o temporário e
// deixar um `read_parquet` apontando para ele faz toda materialização falhar
// com "No files found that match the pattern ...parquet.writing" — o arquivo
// existiu, foi renomeado, e quem lê depois procura no nome velho.
//
// Regra: `tmpDuck` é só para ESCREVER; depois de concluiParte(), tudo que lê
// usa `finalDuck` (ou `final`, para o sistema de arquivos).
export interface ParteEmEscrita {
  /** Caminho de sistema do arquivo temporário. */
  tmp: string
  /** Caminho de sistema do arquivo definitivo. */
  final: string
  /** Destino do COPY (barras normais — o DuckDB no Windows evita escape de \). */
  tmpDuck: string
  /** Para LER depois de concluída. */
  finalDuck: string
}

export function partEmEscrita(dir: string, runId: string): ParteEmEscrita {
  const final = join(dir, `part-${runId}.parquet`)
  const tmp = `${final}${SUFIXO_EM_ESCRITA}`
  return { tmp, final, tmpDuck: tmp.replace(/\\/g, '/'), finalDuck: final.replace(/\\/g, '/') }
}

/** Promove a parte recém-escrita ao nome definitivo. */
export function concluiParte(p: ParteEmEscrita): void {
  renameSync(p.tmp, p.final)
}

/** Remove a parte pela metade. Best-effort: já estamos tratando um erro. */
export function descartaParte(p: ParteEmEscrita): void {
  try { if (existsSync(p.tmp)) unlinkSync(p.tmp) } catch { /* nada a fazer */ }
}

// Um Parquet válido começa E termina com o número mágico "PAR1" — o do fim faz
// parte do rodapé, que é onde o esquema mora e o que o leitor abre primeiro.
// Uma escrita interrompida tem o começo e não tem o fim, e é exatamente esse o
// arquivo que derruba a leitura.
const MAGICA = 'PAR1'
export function parquetIntacto(file: string): boolean {
  let fd: number | undefined
  try {
    const { size } = statSync(file)
    if (size < 12) return false // 4 (início) + 4 (tamanho do rodapé) + 4 (fim)
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4)
    readSync(fd, buf, 0, 4, 0)
    if (buf.toString('latin1') !== MAGICA) return false
    readSync(fd, buf, 0, 4, size - 4)
    return buf.toString('latin1') === MAGICA
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* já fechado */ }
  }
}

export interface FaxinaDoLake {
  parciais: string[]     // restos de escrita interrompida (.writing)
  emQuarentena: string[] // .parquet que não são Parquet
}

// Varre um diretório de conjunto e o devolve LEGÍVEL.
//
// Partes pela metade são apagadas — não contêm dado nenhum que alguém queira.
// Parquet inválido é RENOMEADO, não apagado: tirar do glob já destrava a
// leitura, e apagar sozinho um arquivo que o operador nunca viu é destruir
// evidência de um defeito que talvez ainda não esteja explicado.
export function faxinaDataset(dir: string): FaxinaDoLake {
  const r: FaxinaDoLake = { parciais: [], emQuarentena: [] }
  if (!existsSync(dir)) return r
  for (const f of readdirSync(dir)) {
    const caminho = join(dir, f)
    if (f.endsWith(SUFIXO_EM_ESCRITA)) {
      try { unlinkSync(caminho); r.parciais.push(caminho) } catch { /* segue */ }
      continue
    }
    if (!f.endsWith('.parquet')) continue
    if (parquetIntacto(caminho)) continue
    try {
      renameSync(caminho, `${caminho}.corrompido`)
      r.emQuarentena.push(caminho)
    } catch { /* segue */ }
  }
  return r
}

// Faxina do lake inteiro, no BOOT — quando nada está sincronizando e, portanto,
// nenhum arquivo legítimo está no meio de uma escrita.
export function faxinaLake(): FaxinaDoLake {
  const total: FaxinaDoLake = { parciais: [], emQuarentena: [] }
  if (!existsSync(LAKE_ROOT)) return total
  for (const t of readdirSync(LAKE_ROOT, { withFileTypes: true })) {
    if (!t.isDirectory() || t.name.startsWith('.')) continue
    for (const d of readdirSync(join(LAKE_ROOT, t.name), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const r = faxinaDataset(join(LAKE_ROOT, t.name, d.name))
      total.parciais.push(...r.parciais)
      total.emQuarentena.push(...r.emQuarentena)
    }
  }
  return total
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
