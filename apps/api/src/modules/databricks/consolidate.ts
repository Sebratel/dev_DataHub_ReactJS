// Consolidação do conjunto ANTES do envio ao Databricks.
//
// Por que não mandar a pasta do lake como está: no modo incremental, cada
// execução acrescenta uma parte, e a MESMA linha pode viver em várias delas até
// a compactação rodar — e a compactação é condicional, de propósito. Enviar as
// partes cruas levaria linhas repetidas para o Databricks, que as carregaria
// como fatos distintos. Quem lê o painel não teria como desconfiar.
//
// Então todo envio passa por aqui e produz UM arquivo: deduplicado pela mesma
// regra de recência da compactação, com os timestamps convertidos para UTC e
// ordenado, para que a mesma entrada gere sempre a mesma saída.
import { mkdirSync, statSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { duckQuery } from '../query/duck.js'
import { parquetGlob, listParquet, datasetDir } from '../../core/lake.js'
import { recencyExpression, type RecencyKey } from '../sync/recency.js'
import { config } from '../../core/config.js'

const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
const sqlit = (s: string) => `'${String(s).replace(/'/g, "''")}'`

// ── Nomes de coluna ───────────────────────────────────────────────────────
// O destino exige snake_case sem acento nem caractere especial. A origem é um
// ERP: há coluna com espaço, com acento e com maiúscula. Converter é fácil; o
// que não pode é converter EM SILÊNCIO — por isso o mapeamento vai no
// manifesto, e é por ele que alguém descobre por que a coluna mudou de nome.
export function toSnakeCase(name: string): string {
  const semAcento = name.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const quebrado = semAcento
    // camelCase → camel_case, antes de baixar a caixa.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  // Coluna que vira vazia (só símbolos) ou começa com dígito não é identificador
  // válido no Spark. Prefixar é melhor que falhar no carregamento.
  if (!quebrado) return 'col'
  return /^[0-9]/.test(quebrado) ? `col_${quebrado}` : quebrado
}

/** Resolve colisões geradas pela normalização ("Data Nasc" e "data_nasc"). */
export function mapColumnNames(original: string[]): Map<string, string> {
  const usados = new Set<string>()
  const mapa = new Map<string, string>()
  for (const nome of original) {
    const base = toSnakeCase(nome)
    let destino = base
    let n = 2
    while (usados.has(destino)) destino = `${base}_${n++}`
    usados.add(destino)
    mapa.set(nome, destino)
  }
  return mapa
}

export interface ColunaConsolidada {
  /** Nome no Parquet do lake. */
  source: string
  /** Nome enviado ao Databricks. */
  name: string
  /** Tipo do DuckDB, já depois da conversão de fuso. */
  type: string
  nullable: boolean
  /** true = passou por timezone(origem) para virar instante UTC. */
  convertedToUtc: boolean
}

export interface Consolidado {
  files: string[]
  rowCount: number
  sourceParts: number
  columns: ColunaConsolidada[]
  /** Colunas cujo nome mudou na normalização. */
  renamed: Array<{ from: string; to: string }>
  /** Preenchido quando o conjunto não tem dedupe_keys. */
  warning?: string
  /** Diretório temporário a remover depois do envio. */
  tmpDir: string
}

/**
 * TIMESTAMP sem fuso é o caso que importa: o lake guarda hora local de São
 * Paulo nessas colunas, e o Spark lê Parquet sem fuso como se fosse UTC. Sem
 * conversão, todo horário chega 3 h deslocado — e, como nada falha, o erro só
 * apareceria num relatório que ninguém consegue explicar.
 *
 * TIMESTAMPTZ já carrega o instante, então fica como está. DATE não tem hora e
 * converter só poderia estragá-la (viraria o dia anterior às 21h).
 */
export function precisaConverterFuso(duckType: string): boolean {
  const t = duckType.toUpperCase()
  if (!t.startsWith('TIMESTAMP')) return false
  return !t.includes('WITH TIME ZONE')
}

/** Nanossegundos: o Spark não lê TIMESTAMP(NANOS) por padrão. Desce para µs. */
function expressaoColuna(source: string, duckType: string, tz: string): string {
  const col = ident(source)
  const t = duckType.toUpperCase()
  if (!precisaConverterFuso(duckType)) return col
  const emMicro = t.includes('_NS') ? `cast(${col} as TIMESTAMP)` : col
  return `timezone(${sqlit(tz)}, ${emMicro})`
}

export interface ConsolidarArgs {
  tenantSlug: string
  slug: string
  dedupeKeys: string[]
  recencyKeys: RecencyKey[]
  runId: string
  /** Prefixo do nome do arquivo: HHmm em São Paulo. */
  hhmm: string
}

export async function consolidar(args: ConsolidarArgs): Promise<Consolidado> {
  const { tenantSlug, slug, dedupeKeys, recencyKeys, runId, hhmm } = args
  const datasetDirPath = datasetDir(tenantSlug, slug)
  const partes = listParquet(datasetDirPath)
  if (!partes.length) throw new Error(`Conjunto ${slug} não tem Parquet no lake.`)

  const glob = parquetGlob(datasetDirPath)
  const descr = await duckQuery(`describe select * from read_parquet(${sqlit(glob)})`)
  const colunasOrigem = descr.rows.map((r) => ({
    name: String(r.column_name),
    type: String(r.column_type),
    nullable: String(r.null ?? 'YES').toUpperCase() !== 'NO',
  }))
  if (!colunasOrigem.length) throw new Error(`Conjunto ${slug}: Parquet sem colunas.`)

  const mapa = mapColumnNames(colunasOrigem.map((c) => c.name))
  const tz = config.databricks.sourceTimezone

  const colunas: ColunaConsolidada[] = colunasOrigem.map((c) => ({
    source: c.name,
    name: mapa.get(c.name)!,
    type: precisaConverterFuso(c.type) ? 'TIMESTAMP WITH TIME ZONE' : c.type,
    nullable: c.nullable,
    convertedToUtc: precisaConverterFuso(c.type),
  }))

  const projecao = colunas
    .map((c) => {
      const origem = colunasOrigem.find((o) => o.name === c.source)!
      return `${expressaoColuna(c.source, origem.type, tz)} as ${ident(c.name)}`
    })
    .join(', ')

  // Dedup pela MESMA regra da compactação — recencyExpression é importada, não
  // reescrita. Duas cópias desta regra divergiriam, e a divergência só
  // apareceria como "o Databricks mostra uma versão diferente da linha".
  const chavesPresentes = dedupeKeys.filter((k) => colunasOrigem.some((c) => c.name === k))
  const faltantes = dedupeKeys.filter((k) => !chavesPresentes.includes(k))
  let warning: string | undefined
  let fonte: string

  if (!dedupeKeys.length) {
    warning = `Conjunto ${slug} não tem dedupe_keys: as partes foram unidas SEM deduplicar. ` +
      'Se houver linha repetida no lake, ela chega repetida ao Databricks.'
    fonte = `read_parquet(${sqlit(glob)})`
  } else if (faltantes.length) {
    // Chave configurada que não existe no Parquet derrubaria a consulta inteira
    // com "Referenced column not found". Avisar e seguir sem dedup é pior que
    // falhar: enviaria duplicata mascarada de sucesso.
    throw new Error(
      `Conjunto ${slug}: dedupe_keys ${faltantes.join(', ')} não existe(m) no Parquet do lake.`,
    )
  } else {
    const partition = chavesPresentes.map(ident).join(', ')
    const recency = recencyExpression(recencyKeys)
    fonte = `(select * exclude (__rn) from (
        select *, row_number() over (
          partition by ${partition} order by ${recency} desc nulls last
        ) as __rn
        from read_parquet(${sqlit(glob)})
      ) where __rn = 1)`
  }

  // Ordem estável: a mesma entrada gera o mesmo arquivo, então um reenvio do
  // mesmo run_id sobrescreve byte a byte em vez de criar diferença espúria.
  const ordem = chavesPresentes.length
    ? ` order by ${chavesPresentes.map((k) => ident(mapa.get(k)!)).join(', ')}`
    : ''

  const tmpDir = join(tmpdir(), 'datahub-databricks', `${slug}-${runId}`)
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const alvo = join(tmpDir, `${hhmm}_${runId}.parquet`).replace(/\\/g, '/')

  await duckQuery(
    `copy (select ${projecao} from ${fonte}${ordem}) ` +
    `to ${sqlit(alvo)} (format parquet, compression zstd)`,
  )

  let files = [join(tmpDir, `${hhmm}_${runId}.parquet`)]
  // Acima de maxPartBytes, reescreve dividido. O teto da Files API é 5 GB, e
  // nenhum conjunto do piloto chega perto — este caminho existe para o dia em
  // que um chegar, não para o piloto.
  if (statSync(files[0]).size > config.databricks.maxPartBytes) {
    rmSync(files[0], { force: true })
    const saida = join(tmpDir, 'partes').replace(/\\/g, '/')
    await duckQuery(
      `copy (select ${projecao} from ${fonte}${ordem}) to ${sqlit(saida)} ` +
      `(format parquet, compression zstd, file_size_bytes ${config.databricks.maxPartBytes})`,
    )
    const geradas = readdirSync(join(tmpDir, 'partes')).filter((f) => f.endsWith('.parquet')).sort()
    files = geradas.map((f, i) => {
      const destino = join(tmpDir, `${hhmm}_${runId}_part-${String(i + 1).padStart(4, '0')}.parquet`)
      renameSync(join(tmpDir, 'partes', f), destino)
      return destino
    })
    rmSync(join(tmpDir, 'partes'), { recursive: true, force: true })
  }

  const lista = files.map((f) => sqlit(f.replace(/\\/g, '/'))).join(', ')
  const rowCount = Number(
    (await duckQuery(`select count(*) as n from read_parquet([${lista}])`)).rows[0]?.n ?? 0,
  )

  const renamed = colunas.filter((c) => c.source !== c.name).map((c) => ({ from: c.source, to: c.name }))
  return { files, rowCount, sourceParts: partes.length, columns: colunas, renamed, warning, tmpDir }
}
