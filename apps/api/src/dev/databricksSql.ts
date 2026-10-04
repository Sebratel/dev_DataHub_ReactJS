// Consulta SQL no workspace, pela Statement Execution API. Serve à conferência
// que o piloto exige: a contagem da tabela Delta bate com o row_count do
// manifesto?
//
// ATENÇÃO: usar isto ACORDA o SQL Warehouse, e warehouse acordado custa. É
// para conferência pontual, não para monitoramento em laço.
//
// Uso: npm run databricks:sql --workspace apps/api -- "select 1"
import { config } from '../core/config.js'

const { host, token } = config.databricks
if (!host || !token) { console.error('Defina DATABRICKS_HOST e DATABRICKS_TOKEN no .env.'); process.exit(1) }

const sql = process.argv.slice(2).join(' ').trim()
if (!sql) { console.error('Passe o SQL: npm run databricks:sql --workspace apps/api -- "select 1"'); process.exit(1) }

async function api<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`https://${host}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(120_000),
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${caminho}: ${texto.slice(0, 400)}`)
  return (texto ? JSON.parse(texto) : {}) as T
}

interface Warehouse { id: string; name: string; state: string; enable_serverless_compute?: boolean }
const { warehouses = [] } = await api<{ warehouses?: Warehouse[] }>('GET', '/api/2.0/sql/warehouses')
if (!warehouses.length) { console.error('Nenhum SQL Warehouse no workspace.'); process.exit(1) }
// Prefere o serverless: sobe em segundos em vez de minutos.
const wh = warehouses.find((w) => w.enable_serverless_compute) ?? warehouses[0]
console.log(`Warehouse: ${wh.name} (${wh.state})\n`)

interface Resposta {
  statement_id: string
  status: { state: string; error?: { message?: string } }
  manifest?: { schema?: { columns?: Array<{ name: string }> } }
  result?: { data_array?: string[][] }
}

let r = await api<Resposta>('POST', '/api/2.0/sql/statements', {
  warehouse_id: wh.id, statement: sql, wait_timeout: '30s', format: 'JSON_ARRAY',
})
// PENDING/RUNNING quando o warehouse ainda está acordando.
for (let i = 0; i < 40 && (r.status.state === 'PENDING' || r.status.state === 'RUNNING'); i++) {
  await new Promise((x) => setTimeout(x, 3_000))
  r = await api<Resposta>('GET', `/api/2.0/sql/statements/${r.statement_id}`)
}

if (r.status.state !== 'SUCCEEDED') {
  console.error(`${r.status.state}: ${r.status.error?.message ?? '(sem detalhe)'}`)
  process.exit(1)
}

const colunas = r.manifest?.schema?.columns?.map((c) => c.name) ?? []
const linhas = r.result?.data_array ?? []
console.log(colunas.join(' | '))
console.log(colunas.map((c) => '-'.repeat(c.length)).join('-+-'))
for (const l of linhas) console.log(l.map((v) => (v === null ? 'NULL' : v)).join(' | '))
console.log(`\n${linhas.length} linha(s).`)
