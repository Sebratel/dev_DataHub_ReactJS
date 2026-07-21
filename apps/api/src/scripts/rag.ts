// ─────────────────────────────────────────────────────────────────────────
// PLAYGROUND de busca semântica — para você EXPERIMENTAR o RAG na mão.
//
// Uso (a partir da raiz do monorepo):
//   npm run rag --workspace apps/api -- "clientes que cancelaram"
//   npm run rag --workspace apps/api -- "faturamento por plano"
//
// Ele faz o MESMO que a IA faz internamente: transforma sua pergunta em vetor
// e pergunta ao pgvector quais datasets estão mais "próximos" em significado.
// Brinque: mude a pergunta, edite a descrição de um dataset na tela e rode de
// novo — o ranking muda. É a melhor forma de sentir como embeddings funcionam.
// ─────────────────────────────────────────────────────────────────────────
import { embedQuery, toVectorLiteral } from '../modules/ai/embeddings.js'
import { db } from '../db/pool.js'

const query = process.argv.slice(2).join(' ').trim()
if (!query) {
  console.error('Uso: npm run rag --workspace apps/api -- "sua pergunta aqui"')
  process.exit(1)
}

// 1) Pergunta -> vetor de 384 números (prefixo "query:" do modelo e5).
const vec = toVectorLiteral(await embedQuery(query))

// 2) pgvector ordena por DISTÂNCIA DE COSSENO (<=>): menor = mais parecido.
const rows = (await db.query(
  `select slug, name, description,
          round((embedding <=> $1::vector)::numeric, 4) as dist
     from datasets where embedding is not null
    order by embedding <=> $1::vector limit 5`,
  [vec],
)).rows

console.log(`\nPergunta: "${query}"\n`)
if (!rows.length) {
  console.log('Nenhum dataset indexado ainda.')
  console.log('Suba a API uma vez, ou chame POST /api/v1/datasets/reindex-embeddings (admin).')
} else {
  rows.forEach((r, i) => {
    const dist = Number(r.dist)
    const simPct = Math.max(0, (1 - dist) * 100) // intuição: 1 - distância ≈ similaridade
    const bar = '█'.repeat(Math.round(simPct / 5)).padEnd(20, '░')
    console.log(`${i + 1}. ${r.name}  (${r.slug})`)
    console.log(`   ${bar} ~${simPct.toFixed(0)}%   (distância=${dist})`)
    if (r.description) console.log(`   "${String(r.description).slice(0, 100)}"`)
    console.log()
  })
}

await db.end()
process.exit(0)
