// Permissão mínima da credencial do Data Hub, e a prova de que ela é mínima.
//
// Sem argumento: lista os service principals do workspace.
// Com o applicationId: aplica os GRANTs da seção 11.3 do spec e CONFERE o que
// a identidade passou a enxergar.
//
// A conferência importa tanto quanto a concessão: o objetivo não é "o Data Hub
// consegue escrever", é "o Data Hub consegue escrever E MAIS NADA". Só o
// primeiro é fácil de ver sem querer.
//
// Uso: npm run databricks:grants --workspace apps/api [-- <applicationId>]
import { config } from '../core/config.js'

const CATALOGO = 'piloto_mariadb'
const VOLUME = `${CATALOGO}.landing.arquivos`
const { host, token } = config.databricks
if (!host || !token) { console.error('Defina DATABRICKS_HOST e DATABRICKS_TOKEN no .env.'); process.exit(1) }

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

interface Warehouse { id: string; name: string; enable_serverless_compute?: boolean }
interface Resposta {
  statement_id: string
  status: { state: string; error?: { message?: string } }
  manifest?: { schema?: { columns?: Array<{ name: string }> } }
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

interface SP { displayName?: string; applicationId?: string; active?: boolean }
const lista = await api<{ Resources?: SP[] }>('GET', '/api/2.0/preview/scim/v2/ServicePrincipals')
const sps = lista.Resources ?? []

const alvo = process.argv[2]
if (!alvo) {
  console.log(`\nService principals no workspace (${sps.length}):\n`)
  if (!sps.length) {
    console.log('  (nenhum)\n')
    console.log('Crie em Settings → Identity and access → Service principals → Add,')
    console.log('depois rode de novo passando o Application ID:')
    console.log('  npm run databricks:grants --workspace apps/api -- <applicationId>')
  }
  for (const s of sps) {
    console.log(`  ${s.displayName ?? '(sem nome)'}  ${s.applicationId}  ${s.active ? 'ativo' : 'INATIVO'}`)
  }
  process.exit(0)
}

const sp = sps.find((s) => s.applicationId === alvo)
if (!sp) {
  console.error(`Service principal ${alvo} não existe neste workspace.`)
  console.error('Rode sem argumento para ver os que existem.')
  process.exit(1)
}
console.log(`\nAplicando a permissão mínima a "${sp.displayName}" (${alvo})\n`)

// Escrever no volume e nada além. Nenhum GRANT em bronze/prata/ouro: o Data Hub
// entrega arquivo, quem cria tabela é o job de carga, com outra identidade.
const GRANTS = [
  `GRANT USE CATALOG ON CATALOG ${CATALOGO} TO \`${alvo}\``,
  `GRANT USE SCHEMA ON SCHEMA ${CATALOGO}.landing TO \`${alvo}\``,
  `GRANT READ VOLUME, WRITE VOLUME ON VOLUME ${VOLUME} TO \`${alvo}\``,
]
for (const g of GRANTS) {
  await sql(g)
  console.log(`  ok   ${g.replace(/TO `.*`/, 'TO <sp>')}`)
}

// ── A parte que prova que é MÍNIMA ───────────────────────────────────────
console.log('\nConferência — o que esta identidade enxerga:\n')
const mostra = async (rotulo: string, statement: string) => {
  try {
    const linhas = await sql(statement)
    const dele = linhas.filter((l) => l.some((c) => c === alvo))
    console.log(`  ${rotulo}: ${dele.length ? dele.map((l) => l.join(' ')).join(' | ') : '(nenhum)'}`)
  } catch (e) {
    console.log(`  ${rotulo}: erro — ${(e as Error).message}`)
  }
}
await mostra('catálogo  ', `SHOW GRANTS ON CATALOG ${CATALOGO}`)
await mostra('landing   ', `SHOW GRANTS ON SCHEMA ${CATALOGO}.landing`)
await mostra('volume    ', `SHOW GRANTS ON VOLUME ${VOLUME}`)
for (const camada of ['bronze', 'prata', 'ouro']) {
  await mostra(`${camada.padEnd(10)}`, `SHOW GRANTS ON SCHEMA ${CATALOGO}.${camada}`)
}
console.log('\nEsperado: permissão no catálogo, no schema landing e no volume — e NENHUMA')
console.log('em bronze, prata e ouro. Se aparecer algo lá, revogue.')
