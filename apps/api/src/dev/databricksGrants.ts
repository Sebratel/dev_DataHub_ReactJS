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

// Permissão pela API do Unity Catalog, e não por GRANT em SQL.
//
// GRANT é SQL, SQL precisa de um warehouse, e warehouse é compute que liga,
// demora e custa — para três linhas de permissão. A API faz o mesmo sem acordar
// nada. E, quando o compute está indisponível (trial vencido, conta bloqueada),
// esta é a única via que ainda funciona: foi exatamente o caso em 18/10/2026.
type Privilegio = 'USE_CATALOG' | 'USE_SCHEMA' | 'READ_VOLUME' | 'WRITE_VOLUME'

interface Atribuicao { principal: string; privileges: Privilegio[] }

async function concede(
  tipo: 'catalog' | 'schema' | 'volume', nome: string, principal: string, add: Privilegio[],
): Promise<void> {
  await api('PATCH', `/api/2.1/unity-catalog/permissions/${tipo}/${encodeURIComponent(nome)}`, {
    changes: [{ principal, add }],
  })
}

async function permissoesDe(
  tipo: 'catalog' | 'schema' | 'volume', nome: string, principal: string,
): Promise<Privilegio[]> {
  const r = await api<{ privilege_assignments?: Atribuicao[] }>(
    'GET', `/api/2.1/unity-catalog/permissions/${tipo}/${encodeURIComponent(nome)}`
      + `?principal=${encodeURIComponent(principal)}`)
  return r.privilege_assignments?.find((a) => a.principal === principal)?.privileges ?? []
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

// Service principal criado no nível da CONTA não entra no workspace sozinho —
// é por isso que ele não aparece numa listagem feita aqui mesmo tendo sido
// criado. Adicionar ao workspace é um POST no SCIM, com o applicationId.
let sp = sps.find((s) => s.applicationId === alvo)
if (!sp) {
  console.log(`Service principal ${alvo} ainda não está neste workspace. Tentando adicionar…`)
  try {
    sp = await api<SP>('POST', '/api/2.0/preview/scim/v2/ServicePrincipals', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal'],
      applicationId: alvo,
      displayName: 'Data Hub (envio ao volume)',
      active: true,
    })
    console.log('  ok   adicionado ao workspace\n')
  } catch (e) {
    // 403 aqui é esperado quando o SP foi criado no nível da CONTA: dar acesso
    // ao workspace é operação de conta, e um token de workspace não a faz.
    // Não é impedimento para as permissões do Unity Catalog, que vivem no
    // metastore — por isso seguimos em vez de abortar.
    console.log(`  !    não consegui adicionar pelo token de workspace (${(e as Error).message.slice(0, 80)}…)`)
    console.log('       Isso se resolve no console da CONTA — ver instrução no fim.\n')
  }
}
console.log(`Aplicando a permissão mínima a ${sp?.displayName ?? alvo} (${alvo})\n`)

// Escrever no volume e nada além. Nenhuma permissão em bronze/prata/ouro: o
// Data Hub entrega arquivo; quem cria tabela é o job de carga, com outra
// identidade. Dar a ele acesso de escrita aos schemas seria dar poder que a
// função dele não usa — e que um vazamento do segredo usaria.
// Conceder e CONFERIR na sequência, um a um.
//
// A API aceita um PATCH para um principal que ela não reconhece e responde
// 200 sem aplicar nada — foi o que aconteceu em 18/10/2026, com o service
// principal ainda sem acesso ao workspace. Um "ok" impresso logo após o PATCH
// seria mentira, e mentira que só apareceria mais tarde, como um 403 no envio.
let aplicouTudo = true
async function concedeEConfere(
  tipo: 'catalog' | 'schema' | 'volume', nome: string, add: Privilegio[],
): Promise<void> {
  await concede(tipo, nome, alvo, add)
  const agora = await permissoesDe(tipo, nome, alvo)
  const faltando = add.filter((p) => !agora.includes(p))
  if (faltando.length) {
    aplicouTudo = false
    console.log(`  NÃO PEGOU  ${add.join(', ')} em ${nome} — a API aceitou e não aplicou`)
  } else {
    console.log(`  ok         ${add.join(', ')} em ${nome}`)
  }
}

await concedeEConfere('catalog', CATALOGO, ['USE_CATALOG'])
await concedeEConfere('schema', `${CATALOGO}.landing`, ['USE_SCHEMA'])
await concedeEConfere('volume', VOLUME, ['READ_VOLUME', 'WRITE_VOLUME'])

// ── A parte que prova que é MÍNIMA ───────────────────────────────────────
// Conceder é metade do trabalho. A outra metade é olhar onde ele NÃO deve ter
// nada — só o primeiro é fácil de ver sem querer.
console.log('\nConferência — o que esta identidade enxerga:\n')
const mostra = async (rotulo: string, tipo: 'catalog' | 'schema' | 'volume', nome: string) => {
  try {
    const p = await permissoesDe(tipo, nome, alvo)
    console.log(`  ${rotulo.padEnd(12)} ${p.length ? p.join(', ') : '(nenhuma)'}`)
  } catch (e) {
    console.log(`  ${rotulo.padEnd(12)} erro — ${(e as Error).message}`)
  }
}
await mostra('catálogo', 'catalog', CATALOGO)
await mostra('landing', 'schema', `${CATALOGO}.landing`)
await mostra('volume', 'volume', VOLUME)
for (const camada of ['bronze', 'prata', 'ouro']) {
  await mostra(camada, 'schema', `${CATALOGO}.${camada}`)
}
console.log('\nEsperado: USE_CATALOG, USE_SCHEMA e READ/WRITE_VOLUME — e NENHUMA')
console.log('permissão em bronze, prata e ouro. Se aparecer algo lá, revogue.')

if (!aplicouTudo) {
  console.log('\n── A ORDEM ESTÁ INVERTIDA, e o passo que falta é no console da CONTA ──')
  console.log('Enquanto o service principal não tiver acesso AO WORKSPACE, o Unity Catalog')
  console.log('não o reconhece como principal: ele aceita a concessão e não guarda nada.')
  console.log('Dar acesso ao workspace é operação de CONTA — um token de workspace não faz.')
  console.log('\n  1. accounts.cloud.databricks.com → Workspaces → workspace → Permissions')
  console.log(`     → Add → service principal ${alvo} → papel: User`)
  console.log('  2. rode este script de novo; aí as três permissões pegam.')
  process.exit(1)
}
