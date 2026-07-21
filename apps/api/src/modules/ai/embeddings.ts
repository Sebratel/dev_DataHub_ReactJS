// ─────────────────────────────────────────────────────────────────────────
// Embeddings LOCAIS (RAG do catálogo). Rodamos o modelo multilingual-e5-small
// dentro do próprio Node via transformers.js — sem API externa, sem custo,
// sem chave. Um "embedding" é um vetor de 384 números que representa o
// SIGNIFICADO de um texto; textos parecidos ficam próximos no espaço vetorial.
//
// Por que e5? É um modelo de RETRIEVAL: foi treinado para casar uma PERGUNTA
// com o TRECHO que a responde (busca assimétrica). Ele exige prefixos:
//   - "query: <pergunta>"   → ao vetorizar o que o usuário procura
//   - "passage: <documento>"→ ao vetorizar o que está no catálogo
// Sem os prefixos a qualidade cai. É uma pegadinha clássica de e5.
//
// ROBUSTEZ (importante): o runtime por baixo (onnxruntime-node) traz binários
// nativos glibc — NÃO carregam em Alpine/musl. Por isso:
//   1. NÃO importamos '@huggingface/transformers' no topo do módulo (senão uma
//      falha derrubaria o boot da API inteira). Usamos import DINÂMICO, só
//      quando de fato formos gerar um embedding.
//   2. Se a carga falhar (ou EMBEDDINGS_ENABLED=false), auto-desabilitamos e a
//      busca cai para textual. A API NUNCA quebra por causa de embeddings.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'

export const EMBEDDING_DIM = 384
const MODEL = 'Xenova/multilingual-e5-small'

// Desligado explicitamente por env, ou automaticamente se o runtime falhar.
let disabled = process.env.EMBEDDINGS_ENABLED === 'false'

// Tipo mínimo do pipeline (evita depender do tipo estático da lib, que só
// existiria com o import estático que estamos justamente evitando).
type Extractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>

// Carrega o modelo UMA vez, sob demanda. A Promise é cacheada para chamadas
// concorrentes não iniciarem dois carregamentos.
let extractorPromise: Promise<Extractor> | null = null
function getExtractor(): Promise<Extractor> {
  if (disabled) {
    return Promise.reject(new Error('embeddings desabilitado (EMBEDDINGS_ENABLED=false ou runtime indisponível)'))
  }
  if (!extractorPromise) {
    console.log(`[embeddings] carregando modelo ${MODEL} (1ª vez pode baixar ~120MB)…`)
    extractorPromise = (async () => {
      // Import DINÂMICO — o runtime nativo só é tocado aqui, nunca no boot.
      const { pipeline } = await import('@huggingface/transformers')
      return (await pipeline('feature-extraction', MODEL)) as unknown as Extractor
    })().catch((e) => {
      disabled = true // não tenta de novo nesta execução
      extractorPromise = null
      console.warn(`[embeddings] indisponível — busca semântica desligada, usando fallback textual. (${(e as Error).message})`)
      throw e
    })
  }
  return extractorPromise
}

export function embeddingsEnabled(): boolean {
  return !disabled
}

// Texto → vetor de 384 números (já normalizado, pronto para distância cosseno).
async function embed(text: string, kind: 'query' | 'passage'): Promise<number[]> {
  const extractor = await getExtractor()
  // pooling 'mean' = média dos tokens → 1 vetor por frase.
  // normalize true = vetor unitário → produto interno vira cosseno direto.
  const output = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

export const embedQuery = (text: string) => embed(text, 'query')

// pgvector recebe o vetor como texto no formato '[0.1,0.2,...]' e nós fazemos
// o cast ::vector no SQL. Simples e sem dependência extra de serialização.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

// Monta o "documento" que representa um dataset para a busca: tudo que ajuda a
// casar com a intenção do usuário — nome, descrição, tags e os rótulos dos
// campos. Ex.: um dataset "contratos_encerrados" com campo "motivo_cancelamento"
// passa a casar com a pergunta "clientes que cancelaram".
function buildDatasetDocument(ds: {
  name: string
  description: string | null
  tags: string[] | null
  fieldText: string | null
}): string {
  return [
    ds.name,
    ds.description ?? '',
    (ds.tags ?? []).join(' '),
    ds.fieldText ?? '',
  ].filter(Boolean).join('. ').slice(0, 2000) // teto de segurança de tamanho
}

// Re-indexa os datasets cujo embedding está FALTANDO ou DESATUALIZADO (o texto
// mudou desde a última vez). Idempotente e barato: só recomputa o que mudou.
// NUNCA lança — se o runtime estiver indisponível, apenas não indexa nada.
export async function reindexEmbeddings(datasetId?: string): Promise<number> {
  if (disabled) return 0
  const rows = (await db.query(
    `select d.id, d.name, d.description, d.tags, d.embedding_text,
            (select string_agg(coalesce(f.label,'') || ' ' || coalesce(f.description,''), '. ')
               from dataset_fields f where f.dataset_id = d.id and not f.hidden) as field_text
       from datasets d
      where ($1::uuid is null or d.id = $1::uuid)`,
    [datasetId ?? null],
  )).rows

  let updated = 0
  for (const r of rows) {
    const doc = buildDatasetDocument({
      name: r.name, description: r.description, tags: r.tags, fieldText: r.field_text,
    })
    if (doc === r.embedding_text) continue // já está fresco → pula
    let vec: number[]
    try {
      vec = await embed(doc, 'passage')
    } catch {
      break // runtime indisponível (disabled já foi setado) → aborta silenciosamente
    }
    await db.query(
      `update datasets set embedding = $1::vector, embedding_text = $2, embedded_at = now()
        where id = $3`,
      [toVectorLiteral(vec), doc, r.id],
    )
    updated++
  }
  if (updated) console.log(`[embeddings] ${updated} dataset(s) (re)indexado(s).`)
  return updated
}
