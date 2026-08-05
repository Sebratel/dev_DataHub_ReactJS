// Trava contra "escrevi o router e esqueci de montar" —
// `npm run routes:check --workspace apps/api`.
//
// Foi exatamente o que aconteceu com os Notebooks: o módulo inteiro existia,
// tipava e compilava, mas nunca foi ligado no index.ts. Nada acusou, porque um
// router não montado é código válido que ninguém chama — e o sintoma só
// aparece em produção, como "Rota não encontrada".
//
// O typecheck não pega isso e um teste de rota exigiria subir a aplicação.
// Uma checagem estática resolve: todo router exportado precisa estar importado
// E montado.
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

const SRC = resolve(import.meta.dirname, '..')

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

// Comentários fora ANTES de procurar: um `// app.use(...)` comentado casaria
// com o regex e a checagem passaria justamente no caso que ela existe para
// pegar. (Descoberto testando a própria trava — ela falhava em silêncio.)
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const index = stripComments(await readFile(join(SRC, 'index.ts'), 'utf8'))
const files = (await walk(join(SRC, 'modules'))).concat(await walk(join(SRC, 'connectors')))

interface Missing { router: string; file: string; reason: string }
const missing: Missing[] = []
let found = 0

for (const file of files) {
  const src = await readFile(file, 'utf8')
  // `export const xRouter = Router()` — a forma usada em todo o projeto.
  for (const m of src.matchAll(/export\s+const\s+(\w*[Rr]outer)\s*[:=]/g)) {
    const name = m[1]
    found++
    const rel = relative(SRC, file).replace(/\\/g, '/')
    if (!new RegExp(`\\b${name}\\b`).test(index)) {
      missing.push({ router: name, file: rel, reason: 'não importado no index.ts' })
      continue
    }
    if (!new RegExp(`app\\.use\\([^)]*\\b${name}\\b`).test(index)) {
      missing.push({ router: name, file: rel, reason: 'importado mas nunca montado com app.use()' })
    }
  }
}

console.log(`${found} router(es) exportado(s) encontrado(s).`)
if (missing.length) {
  console.error('\nROUTERS NÃO LIGADOS:')
  for (const m of missing) console.error(`  ${m.router}  (${m.file}) — ${m.reason}`)
  console.error('\nUm router não montado responde 404 em produção sem nenhum aviso em tempo de build.')
  process.exit(1)
}
console.log('Todos importados e montados no index.ts.')
