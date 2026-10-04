// Provisiona o lado do WORKSPACE: sobe o notebook de carga e cria o job que o
// dispara quando um arquivo chega no volume.
//
// Mora em dev/ e fala com a API REST por conta própria, sem reaproveitar o
// cliente de produção. É de propósito: aquele módulo existe para ENVIAR
// arquivo com uma credencial que só tem WRITE VOLUME, e administrar workspace
// não é trabalho dele. Misturar as duas coisas convidaria a dar ao Data Hub
// permissões que ele não precisa ter.
//
// Idempotente: rodar de novo atualiza o notebook e o job existentes.
//
// Uso: npm run databricks:setup-job --workspace apps/api
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../core/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NOME_JOB = 'Data Hub — carga do volume de chegada'
const VOLUME = '/Volumes/piloto_mariadb/landing/arquivos'

const { host, token } = config.databricks
if (!host || !token) {
  console.error('Defina DATABRICKS_HOST e DATABRICKS_TOKEN no .env.')
  process.exit(1)
}

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

// ── Quem somos no workspace (define onde o notebook mora) ────────────────
const eu = await api<{ userName?: string }>('GET', '/api/2.0/preview/scim/v2/Me')
const usuario = eu.userName
if (!usuario) throw new Error('Não consegui identificar o usuário do token.')
const pastaNotebook = `/Workspace/Users/${usuario}/datahub`
const caminhoNotebook = `${pastaNotebook}/carga_landing`
console.log(`Usuário do token: ${usuario}`)

// ── 1. Sobe o notebook ───────────────────────────────────────────────────
const fonte = readFileSync(resolve(__dirname, '../../../../databricks/carga_landing.py'), 'utf8')
await api('POST', '/api/2.0/workspace/mkdirs', { path: pastaNotebook })
await api('POST', '/api/2.0/workspace/import', {
  path: caminhoNotebook,
  format: 'SOURCE',
  language: 'PYTHON',
  overwrite: true,
  content: Buffer.from(fonte, 'utf8').toString('base64'),
})
console.log(`  ok   notebook em ${caminhoNotebook}`)

// ── 2. Cria (ou atualiza) o job ──────────────────────────────────────────
// Gatilho por CHEGADA DE ARQUIVO, e não por horário: o Data Hub envia quando
// termina de materializar, e esperar a próxima hora cheia atrasaria o dado sem
// motivo. `wait_after_last_change_seconds` existe para o manifesto — que vai
// por último — já ter chegado quando a carga começar.
const definicao = {
  name: NOME_JOB,
  description: 'Lê os manifestos do volume de chegada e carrega as tabelas Delta. '
    + 'Ignora pastas que começam com _ (área de teste do desenvolvimento).',
  tasks: [{
    task_key: 'carga',
    notebook_task: { notebook_path: caminhoNotebook, source: 'WORKSPACE' },
    // Sem cluster declarado = serverless. Para o volume do piloto (cerca de
    // 1,8 milhão de linhas) subir um cluster dedicado custaria mais em tempo
    // de boot do que a carga inteira leva para rodar.
  }],
  trigger: {
    pause_status: 'UNPAUSED',
    file_arrival: {
      url: `${VOLUME}/`,
      min_time_between_triggers_seconds: 60,
      // A API exige > 60 s. Serve ao nosso propósito: dá folga para o
      // manifesto (que o hub envia por último) chegar antes de a carga começar.
      wait_after_last_change_seconds: 90,
    },
  },
  // Uma execução por vez: duas cargas simultâneas escreveriam a mesma tabela.
  max_concurrent_runs: 1,
  queue: { enabled: true },
}

const lista = await api<{ jobs?: Array<{ job_id: number; settings: { name: string } }> }>(
  'GET', `/api/2.2/jobs/list?name=${encodeURIComponent(NOME_JOB)}`)
const existente = lista.jobs?.find((j) => j.settings?.name === NOME_JOB)

if (existente) {
  await api('POST', '/api/2.2/jobs/reset', {
    job_id: existente.job_id, new_settings: definicao,
  })
  console.log(`  ok   job atualizado (id ${existente.job_id})`)
  console.log(`\nAbra em: https://${host}/jobs/${existente.job_id}`)
} else {
  const criado = await api<{ job_id: number }>('POST', '/api/2.2/jobs/create', definicao)
  console.log(`  ok   job criado (id ${criado.job_id})`)
  console.log(`\nAbra em: https://${host}/jobs/${criado.job_id}`)
}
