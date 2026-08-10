// Verifica que os schemas das NOSSAS ferramentas sobrevivem ao dialeto de cada
// provedor — `npm run ai:tools-check --workspace apps/api`.
//
// Existe por causa de um bug real: o Gemini recusou a conversa inteira com
// "Unknown name additionalProperties ... Cannot find field", porque o schema
// dele é um subconjunto FECHADO do OpenAPI e chave desconhecida é erro, não
// algo ignorado. Sem chave de API dá para conferir o essencial: que a
// transformação remove tudo que o Gemini não conhece e preserva o que importa.
import { AI_TOOLS, WIDGET_BUILDER_TOOLS } from '../modules/ai/tools.js'
import { toGeminiSchema } from '../modules/ai/provider.js'

// Tudo que o Gemini NÃO conhece e que costuma aparecer em JSON Schema nosso.
const PROIBIDAS = [
  'additionalProperties', '$schema', '$ref', '$defs', 'definitions',
  'oneOf', 'allOf', 'not', 'const', 'patternProperties', 'examples',
]

function chavesDe(node: unknown, achadas = new Set<string>()): Set<string> {
  if (Array.isArray(node)) { node.forEach((n) => chavesDe(n, achadas)); return achadas }
  if (!node || typeof node !== 'object') return achadas
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    achadas.add(k)
    chavesDe(v, achadas)
  }
  return achadas
}

const todas = [...AI_TOOLS, ...WIDGET_BUILDER_TOOLS]
let falhas = 0

console.log(`${todas.length} ferramenta(s) para verificar.\n`)

for (const t of todas) {
  const antes = chavesDe(t.inputSchema)
  const limpo = toGeminiSchema(t.inputSchema)
  const depois = chavesDe(limpo)

  const sobreviventes = PROIBIDAS.filter((k) => depois.has(k))
  const removidas = PROIBIDAS.filter((k) => antes.has(k) && !depois.has(k))

  // O sanitizador não pode ser um formatador que apaga tudo: as chaves que
  // definem a ferramenta precisam continuar lá.
  const src = t.inputSchema as Record<string, unknown>
  const perdeuEstrutura = ['type', 'properties', 'required']
    .filter((k) => k in src && !depois.has(k))

  const ok = !sobreviventes.length && !perdeuEstrutura.length
  if (!ok) falhas++
  console.log(`${ok ? 'PASSA' : 'FALHA'}  ${t.name}`)
  if (removidas.length) console.log(`        removidas: ${removidas.join(', ')}`)
  if (sobreviventes.length) console.log(`        AINDA PRESENTES: ${sobreviventes.join(', ')}`)
  if (perdeuEstrutura.length) console.log(`        ESTRUTURA PERDIDA: ${perdeuEstrutura.join(', ')}`)
}

console.log(`\n${falhas ? `${falhas} ferramenta(s) com problema.` : 'Todas as ferramentas passam no dialeto do Gemini.'}`)
process.exit(falhas ? 1 : 0)
