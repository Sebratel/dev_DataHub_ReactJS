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
// ─────────────────────────────────────────────────────────────────────────
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { db } from '../../db/pool.js'

export const EMBEDDING_DIM = 384
const MODEL = 'Xenova/multilingual-e5-small'

// O modelo é pesado para carregar (baixa ~120MB na 1ª vez e inicializa o
// runtime ONNX). Carregamos UMA vez, sob demanda, e reaproveitamos. A Promise
// é cacheada para que chamadas concorrentes não iniciem dois carregamentos.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    console.log(`[embeddings] carregando modelo ${MODEL} (1ª vez pode baixar ~120MB)…`)
    extractorPromise = pipeline('feature-extraction', MODEL)
  }
  return extractorPromise
}

// Texto → vetor de 384 números (já normalizado, pronto para distância cosseno).
async function embed(text: string, kind: 'query' | 'passage'): Promise<number[]> {
  const extractor = await getExtractor()
  // pooling 'mean' = média dos tokens → 1 vetor por frase.
  // normalize true = vetor unitário → produto interno vira cosseno direto.
  const output = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true })
  return Array.from(output.data as Float32Array)
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
// Chamado no boot e sob demanda (endpoint admin) e após criar/editar dataset.
export async function reindexEmbeddings(datasetId?: string): Promise<number> {
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
    const vec = await embed(doc, 'passage')
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
