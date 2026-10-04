// Dispara o job de carga à mão e espera o resultado, imprimindo a saída do
// notebook. O gatilho normal é a chegada de arquivo; isto existe para testar e
// para reprocessar sem esperar o próximo envio.
//
// Uso: npm run databricks:run-job --workspace apps/api
import { config } from '../core/config.js'

const NOME_JOB = 'Data Hub — carga do volume de chegada'
const { host, token } = config.databricks
if (!host || !token) { console.error('Defina DATABRICKS_HOST e DATABRICKS_TOKEN no .env.'); process.exit(1) }

async function api<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`https://${host}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${caminho}: ${texto.slice(0, 400)}`)
  return (texto ? JSON.parse(texto) : {}) as T
}

const lista = await api<{ jobs?: Array<{ job_id: number; settings: { name: string } }> }>(
  'GET', `/api/2.2/jobs/list?name=${encodeURIComponent(NOME_JOB)}`)
const job = lista.jobs?.find((j) => j.settings?.name === NOME_JOB)
if (!job) { console.error(`Job "${NOME_JOB}" não existe. Rode databricks:setup-job antes.`); process.exit(1) }

const { run_id } = await api<{ run_id: number }>('POST', '/api/2.2/jobs/run-now', { job_id: job.job_id })
console.log(`Execução ${run_id} disparada. Aguardando…`)

interface Run {
  status?: { state?: string; termination_details?: { message?: string } }
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string }
  tasks?: Array<{ run_id: number; task_key: string }>
}

let run: Run = {}
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5_000))
  run = await api<Run>('GET', `/api/2.2/jobs/runs/get?run_id=${run_id}`)
  const estado = run.status?.state ?? run.state?.life_cycle_state
  if (estado === 'TERMINATED' || estado === 'INTERNAL_ERROR' || estado === 'SKIPPED') break
  if (i % 4 === 0) console.log(`  … ${estado}`)
}

const resultado = run.state?.result_state ?? run.status?.state
console.log(`\nResultado: ${resultado}`)
if (run.state?.state_message) console.log(`Mensagem: ${run.state.state_message}`)
if (run.status?.termination_details?.message) {
  console.log(`Detalhe: ${run.status.termination_details.message}`)
}

const task = run.tasks?.[0]
if (task) {
  const out = await api<{ notebook_output?: { result?: string }; error?: string; logs?: string }>(
    'GET', `/api/2.2/jobs/runs/get-output?run_id=${task.run_id}`)
  if (out.logs) console.log(`\n── saída do notebook ──\n${out.logs.slice(-4000)}`)
  if (out.error) console.log(`\n── erro ──\n${out.error.slice(0, 2000)}`)
}
console.log(`\nAbra em: https://${host}/jobs/${job.job_id}/runs/${run_id}`)
process.exit(resultado === 'SUCCESS' ? 0 : 1)
