// Conferência REAL contra o workspace: credencial, permissão no volume e um
// envio de ponta a ponta com um conjunto pequeno do lake local.
//
// Diferente do databricksSmoke (que roda sem rede), este script SOBE ARQUIVO.
// Ele usa o DATABRICKS_VOLUME_PATH do ambiente — mantenha o sufixo /_dev em
// desenvolvimento, porque o job de carga ignora pastas que começam com '_' e
// assim um teste nunca vira tabela.
//
// Não roda a publicação completa de propósito: `publicarDataset` precisa do
// banco de metadados (quem está habilitado, quais as chaves), e o ponto aqui é
// exercitar a REDE e a Files API, que é o que ainda não tinha sido provado.
//
// Uso: npm run databricks:check --workspace apps/api [-- <slug>]
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { config } from '../core/config.js'
import { LAKE_ROOT, listParquet, datasetDir } from '../core/lake.js'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { consolidar } from '../modules/databricks/consolidate.js'
import { montarManifesto } from '../modules/databricks/manifest.js'
import {
  conferirVolume, criarDiretorio, enviarArquivo, listarDiretorio, DatabricksError,
} from '../modules/databricks/client.js'

const TENANT = 'sebratel'
let falhas = 0
const ok = (t: string, d = '') => console.log(`  ok   ${t}${d ? ` — ${d}` : ''}`)
const nok = (t: string, d = '') => { console.log(` FALHA ${t}${d ? ` — ${d}` : ''}`); falhas++ }

// ── 1. O que está configurado (nunca o segredo) ──────────────────────────
console.log('\n1. Configuração')
console.log(`  host        ${config.databricks.host || '(vazio)'}`)
console.log(`  volume      ${config.databricks.volumePath}`)
console.log(`  autenticação ${config.databricks.token ? 'PAT' : config.databricks.clientId ? 'OAuth M2M' : 'NENHUMA'}`)
console.log(`  integração  ${config.databricks.enabled ? 'ligada' : 'DESLIGADA'}`)
if (!config.databricks.host || (!config.databricks.token && !config.databricks.clientId)) {
  nok('credencial e host definidos', 'preencha DATABRICKS_HOST e DATABRICKS_TOKEN no .env')
  process.exit(1)
}
if (!config.databricks.volumePath.includes('/_dev')) {
  console.log('  AVISO: o destino NÃO termina em /_dev — este teste criaria arquivo que o job carregaria.')
}

// ── 2. A credencial enxerga o volume? ────────────────────────────────────
console.log('\n2. Permissão no volume')
const nomeVolume = 'piloto_mariadb.landing.arquivos'
try {
  const v = await conferirVolume(nomeVolume) as { full_name?: string; volume_type?: string }
  ok(`a credencial lê ${nomeVolume}`, `${v.full_name ?? '?'} (${v.volume_type ?? '?'})`)
} catch (e) {
  const err = e as DatabricksError
  nok(`a credencial lê ${nomeVolume}`, err.message)
  if (err.status === 403) console.log('       → falta GRANT READ VOLUME/WRITE VOLUME para esta identidade.')
  if (err.status === 401) console.log('       → token inválido ou expirado.')
  process.exit(1)
}

// ── 3. Escolhe um conjunto pequeno do lake local ─────────────────────────
console.log('\n3. Conjunto de teste')
const pedido = process.argv[2]
const candidatos = readdirSync(join(LAKE_ROOT, TENANT), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ slug: d.name, partes: listParquet(datasetDir(TENANT, d.name)) }))
  .filter((c) => c.partes.length > 0)
const escolhido = pedido
  ? candidatos.find((c) => c.slug === pedido)
  : candidatos.sort((a, b) => a.partes.length - b.partes.length)[0]
if (!escolhido) {
  nok('há conjunto com Parquet no lake local', pedido ? `'${pedido}' não encontrado` : 'lake vazio')
  process.exit(1)
}
ok(`usando '${escolhido.slug}'`, `${escolhido.partes.length} parte(s)`)

// ── 4. Consolida e envia ─────────────────────────────────────────────────
console.log('\n4. Envio')
const runId = randomUUID()
const agora = new Date()
const p = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(agora)
const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00'
const dt = `${g('year')}-${g('month')}-${g('day')}`
const hhmm = `${g('hour')}${g('minute')}`

let tmpDir: string | null = null
try {
  const cons = await consolidar({
    tenantSlug: TENANT, slug: escolhido.slug, dedupeKeys: [], recencyKeys: [], runId, hhmm,
  })
  tmpDir = cons.tmpDir
  ok('consolidado', `${cons.rowCount} linha(s), ${cons.columns.length} coluna(s)`)
  if (cons.warning) console.log(`       aviso: ${cons.warning}`)

  const base = `${config.databricks.volumePath}/bronze/${escolhido.slug}/dt=${dt}`
  await criarDiretorio(base)
  ok('diretório criado no volume', base)

  const arquivos = cons.files.map((local) => ({
    local, volume: `${base}/${local.split(/[\\/]/).pop()}`,
  }))
  for (const a of arquivos) {
    const r = await enviarArquivo(a.volume, readFileSync(a.local))
    ok('Parquet enviado', `${a.volume.split('/').pop()} (${r.attempts} tentativa(s))`)
  }

  const manifesto = await montarManifesto({
    runId, slug: escolhido.slug, layer: 'bronze', sourceConnection: 'dev',
    mode: 'SNAPSHOT', dedupeKeys: [], sourceParts: cons.sourceParts, rowCount: cons.rowCount,
    columns: cons.columns, renamed: cons.renamed, warning: cons.warning,
    sourceTimezone: config.databricks.sourceTimezone, arquivos, extractedAt: agora,
  })
  await enviarArquivo(
    `${base}/${hhmm}_${runId}.manifest.json`,
    Buffer.from(JSON.stringify(manifesto, null, 2), 'utf8'), 'application/json')
  ok('manifesto enviado (por último, como manda a regra)')

  // ── 5. Confere do outro lado ───────────────────────────────────────────
  console.log('\n5. Conferência no volume')
  const conteudo = await listarDiretorio(base)
  const nomes = conteudo.map((c) => c.name)
  const temParquet = nomes.some((n) => n.endsWith('.parquet'))
  const temManifesto = nomes.some((n) => n.endsWith('.manifest.json'))
  temParquet ? ok('o Parquet está lá') : nok('o Parquet está lá', nomes.join(', '))
  temManifesto ? ok('o manifesto está lá') : nok('o manifesto está lá', nomes.join(', '))
  for (const c of conteudo) {
    console.log(`       ${c.name}  ${c.file_size != null ? `${c.file_size} bytes` : ''}`)
  }
} catch (e) {
  const err = e as DatabricksError
  nok('envio', err.message)
  if (err.status === 403) console.log('       → a credencial lê o volume mas não escreve: falta WRITE VOLUME.')
} finally {
  if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* segue */ }
}

console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : '\nTudo certo.')
process.exit(falhas ? 1 : 0)
