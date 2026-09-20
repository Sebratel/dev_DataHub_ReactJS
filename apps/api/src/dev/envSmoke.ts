// Toda variável lida pelo código precisa estar mapeada no docker-compose.yml.
//
// Existe por causa de uma falha real, e do jeito mais traiçoeiro que ela tem:
// `MASTER_ADMIN_EMAILS` foi acrescentada ao config, ao .env.example e ao
// README — mas não ao bloco `environment:` do serviço `api`. Esse bloco lista
// as variáveis UMA A UMA, então o que for definido na stack do Portainer sem
// constar nele não chega ao container.
//
// O sintoma não aponta para a causa: a variável aparece preenchida na tela do
// Portainer, o deploy passa, nada erra — e a API simplesmente nunca a vê. No
// caso do master, o efeito foi o dono do hub perder o próprio acesso sem
// nenhuma mensagem que explicasse por quê.
//
// Em desenvolvimento o problema não aparece: o `.env` da raiz é lido direto
// pelo dotenv, sem passar pelo compose. É exatamente o tipo de divergência
// prod-x-local que só se descobre em produção — a menos que algo confira.
//
// Uso: npm run env:smoke --workspace apps/api
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../..')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Variáveis que NÃO devem estar no compose, com o motivo. Qualquer outra
// ausência é erro — é o que força a decisão em vez do esquecimento.
const DISPENSADAS: Record<string, string> = {
  // O caminho do lake é fixado pelo volume (datahub-lake:/app/data/lake); deixar
  // configurável na stack só criaria o risco de apontar para fora do volume e
  // perder o lake no próximo deploy.
  LAKE_ROOT: 'fixado pelo volume datahub-lake',
  // Só o script de carga sintética (dev/exportSmoke.ts), nunca em produção.
  SMOKE_ROWS: 'script de desenvolvimento',
  // Injetada pelo runtime/ferramentas, não pela stack.
  NODE_ENV: 'definida pelo runtime',
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) tsFiles(p, out)
    else if (f.endsWith('.ts')) out.push(p)
  }
  return out
}

// 1. O que o código lê.
const lidas = new Set<string>()
for (const file of tsFiles(join(REPO, 'apps/api/src'))) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) lidas.add(m[1])
  // Forma indireta: process.env[`${prefixo}_HOST`] nos conectores. Não dá para
  // resolver estaticamente, e as fixas já estão no compose — fora do escopo.
}

// 2. O que o compose entrega ao serviço `api`.
const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8')
const bloco = /\n {2}api:\n([\s\S]*?)\n {2}[a-z-]+:\n/.exec(compose)
if (!bloco) {
  console.error('Não achei o serviço `api` no docker-compose.yml.')
  process.exit(1)
}
const mapeadas = new Set(
  [...bloco[1].matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((m) => m[1]),
)

console.log('\n── variáveis lidas pelo código x entregues pelo compose ──')
const faltando = [...lidas].filter((v) => !mapeadas.has(v) && !(v in DISPENSADAS)).sort()
check(`todas as ${lidas.size} variáveis lidas chegam ao container`,
  faltando.length === 0,
  faltando.length
    ? `sem mapeamento no compose: ${faltando.join(', ')} — defini-las na stack não teria efeito nenhum`
    : `${[...lidas].filter((v) => v in DISPENSADAS).length} dispensada(s) por motivo declarado`)

// 3. As dispensadas precisam continuar fora — se alguém mapear LAKE_ROOT, o
//    motivo declarado aqui deixou de valer e a decisão tem de ser revista.
for (const [v, motivo] of Object.entries(DISPENSADAS)) {
  if (!lidas.has(v)) continue
  check(`${v} segue fora do compose (${motivo})`, !mapeadas.has(v))
}

// 4. A do master é a que motivou tudo isto — conferida pelo nome, para que
//    uma renomeação descuidada não passe em silêncio.
console.log('\n── a variável que motivou este smoke ──')
check('MASTER_ADMIN_EMAILS é lida pelo código', lidas.has('MASTER_ADMIN_EMAILS'))
check('MASTER_ADMIN_EMAILS chega ao container pelo compose', mapeadas.has('MASTER_ADMIN_EMAILS'))
check('MASTER_ADMIN_EMAILS está documentada no .env.example',
  readFileSync(join(REPO, '.env.example'), 'utf8').includes('MASTER_ADMIN_EMAILS'))

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
