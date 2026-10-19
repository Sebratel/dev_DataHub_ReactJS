// Saúde do piloto, do lado do Databricks: o que foi carregado, se a contagem
// ainda bate, o que chegou e NÃO virou tabela, e como os jobs terminaram.
//
// A pergunta que ele responde é a do critério de aceite: "os envios estão
// chegando e o row_count bate?". Conferir isso com SQL avulso toda vez é como
// não conferir — dá trabalho demais para virar hábito.
//
// O caso que mais importa é o terceiro: manifesto no volume SEM carga
// correspondente. É a falha silenciosa do desenho — o envio dá sucesso, o
// arquivo está lá, e a tabela simplesmente não existe (foi o que aconteceria
// com o caminho apontando para /_dev). Nada reclama sozinho.
//
// ATENÇÃO: acorda o SQL Warehouse, e warehouse acordado custa. É para
// acompanhamento pontual, não para laço de monitoramento.
//
// Uso: npm run databricks:status --workspace apps/api
import { config } from '../core/config.js'

const CATALOGO = 'piloto_mariadb'
const VOLUME = `/Volumes/${CATALOGO}/landing/arquivos`
const { host, token, clientId, clientSecret, oauthScope } = config.databricks
if (!host) { console.error('Defina DATABRICKS_HOST no .env.'); process.exit(1) }

async function credencial(): Promise<string> {
  if (token) return token
  if (!clientId || !clientSecret) throw new Error('Sem DATABRICKS_TOKEN nem CLIENT_ID/SECRET.')
  const r = await fetch(`https://${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(oauthScope)}`,
    signal: AbortSignal.timeout(30_000),
  })
  const d = (await r.json()) as { access_token?: string }
  if (!d.access_token) throw new Error(`Não obtive token OAuth (HTTP ${r.status}).`)
  return d.access_token
}
const tok = await credencial()

async function api<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`https://${host}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(120_000),
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${caminho}: ${texto.slice(0, 200)}`)
  return (texto ? JSON.parse(texto) : {}) as T
}

interface Warehouse { id: string; enable_serverless_compute?: boolean }
interface Resposta {
  statement_id: string
  status: { state: string; error?: { message?: string } }
  result?: { data_array?: string[][] }
}
let warehouseId: string | null = null
async function sql(statement: string): Promise<string[][]> {
  if (!warehouseId) {
    const { warehouses = [] } = await api<{ warehouses?: Warehouse[] }>('GET', '/api/2.0/sql/warehouses')
    if (!warehouses.length) throw new Error('Nenhum SQL Warehouse no workspace.')
    warehouseId = (warehouses.find((w) => w.enable_serverless_compute) ?? warehouses[0]).id
  }
  let r = await api<Resposta>('POST', '/api/2.0/sql/statements', {
    warehouse_id: warehouseId, statement, wait_timeout: '30s', format: 'JSON_ARRAY',
  })
  for (let i = 0; i < 40 && (r.status.state === 'PENDING' || r.status.state === 'RUNNING'); i++) {
    await new Promise((x) => setTimeout(x, 3_000))
    r = await api<Resposta>('GET', `/api/2.0/sql/statements/${r.statement_id}`)
  }
  if (r.status.state !== 'SUCCEEDED') {
    throw new Error(`${r.status.state}: ${r.status.error?.message ?? '(sem detalhe)'}`)
  }
  return r.result?.data_array ?? []
}

let problemas = 0

// ── 1. O que está carregado, e a contagem ainda bate? ────────────────────
// Compara o row_count gravado na carga com o count(*) de AGORA. Divergência
// aqui significa que alguém (ou algo) mexeu na tabela por fora do pipeline.
console.log('\n── Tabelas carregadas ──\n')
const cargas = await sql(`
  select dataset_slug, table_name, max(row_count) as linhas, max(loaded_at) as quando,
         count(*) as cargas
    from ${CATALOGO}.landing.cargas_processadas
   group by dataset_slug, table_name order by dataset_slug`)

if (!cargas.length) {
  console.log('  (nenhuma carga registrada)')
} else {
  for (const [slug, tabela, linhas, quando, nCargas] of cargas) {
    let agora = '?'
    let bate = true
    try {
      agora = (await sql(`select count(*) from ${tabela}`))[0]?.[0] ?? '?'
      bate = agora === linhas
    } catch (e) {
      agora = `ERRO: ${(e as Error).message.slice(0, 60)}`
      bate = false
    }
    if (!bate) problemas++
    const marca = bate ? 'ok  ' : 'DIVERGE'
    console.log(`  ${marca} ${slug.padEnd(26)} ${String(linhas).padStart(8)} linha(s) ` +
      `· na tabela ${agora} · ${nCargas} carga(s) · última ${String(quando).slice(0, 19)}`)
  }
}

// ── 2. Chegou e não virou tabela? ────────────────────────────────────────
// A falha silenciosa: manifesto no volume sem run_id em cargas_processadas.
console.log('\n── Envios no volume sem carga correspondente ──\n')
interface Entrada { path: string; name: string; is_directory: boolean }
async function listar(caminho: string): Promise<Entrada[]> {
  try {
    const r = await api<{ contents?: Entrada[] }>(
      'GET', `/api/2.0/fs/directories${caminho.split('/').map(encodeURIComponent).join('/')}`)
    return r.contents ?? []
  } catch { return [] }
}

const processados = new Set(
  (await sql(`select run_id from ${CATALOGO}.landing.cargas_processadas`)).map((l) => l[0]))

let pendentes = 0
for (const camada of await listar(VOLUME)) {
  if (!camada.is_directory || camada.name.startsWith('_')) continue
  for (const conjunto of await listar(`${VOLUME}/${camada.name}`)) {
    if (!conjunto.is_directory) continue
    for (const dia of await listar(`${VOLUME}/${camada.name}/${conjunto.name}`)) {
      if (!dia.is_directory) continue
      for (const arq of await listar(`${VOLUME}/${camada.name}/${conjunto.name}/${dia.name}`)) {
        if (!arq.name.endsWith('.manifest.json')) continue
        // O nome é HHmm_<run_id>.manifest.json.
        const runId = arq.name.replace('.manifest.json', '').split('_').slice(1).join('_')
        if (processados.has(runId)) continue
        pendentes++
        problemas++
        console.log(`  PENDENTE ${camada.name}/${conjunto.name}/${dia.name}/${arq.name}`)
      }
    }
  }
}
if (!pendentes) console.log('  nenhum — todo manifesto entregue virou carga')

// ── 3. Como os jobs têm terminado ────────────────────────────────────────
console.log('\n── Últimas execuções dos jobs ──\n')
const { jobs = [] } = await api<{ jobs?: Array<{ job_id: number; settings: { name: string } }> }>(
  'GET', '/api/2.2/jobs/list?limit=25')
for (const j of jobs.filter((x) => x.settings?.name?.startsWith('Data Hub'))) {
  const { runs = [] } = await api<{
    runs?: Array<{ start_time: number; status?: { state?: string }; state?: { result_state?: string } }>
  }>('GET', `/api/2.2/jobs/runs/list?job_id=${j.job_id}&limit=5`)
  const falhas = runs.filter((r) => r.state?.result_state && r.state.result_state !== 'SUCCESS').length
  if (falhas) problemas++
  console.log(`  ${falhas ? 'ATENÇÃO' : 'ok  '} ${j.settings.name}`)
  for (const r of runs.slice(0, 3)) {
    const q = new Date(r.start_time).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    console.log(`         ${q}  ${r.status?.state ?? '?'} ${r.state?.result_state ?? ''}`)
  }
  if (!runs.length) console.log('         (nenhuma execução ainda)')
}

console.log(problemas
  ? `\n${problemas} ponto(s) de atenção acima.`
  : '\nPiloto saudável: contagens batendo, nada pendente e nenhum job falhando.')
process.exit(problemas ? 1 : 0)
