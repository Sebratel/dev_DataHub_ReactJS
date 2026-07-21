-- Sprint 9: busca semântica do catálogo (RAG). Guardamos, para cada dataset,
-- um EMBEDDING — vetor de 384 números que representa o "significado" do texto
-- (nome + descrição + campos). A busca vira "qual dataset está mais próximo
-- do vetor da pergunta?", em vez de casar substring de nome.
--
-- Requer a imagem pgvector/pgvector:pg16 (a extensão não existe no postgres
-- alpine padrão). Ver docker-compose.yml → serviço datahub-db.
create extension if not exists vector;

alter table datasets
  -- 384 = dimensão do modelo multilingual-e5-small (roda local, ver embeddings.ts).
  add column embedding vector(384),
  -- Texto exato que foi vetorizado. Guardado para (a) depurar e (b) detectar
  -- quando o dataset mudou e o embedding ficou "velho" (re-indexar só o que mudou).
  add column embedding_text text,
  add column embedded_at timestamptz;

-- Índice HNSW para vizinho-mais-próximo por distância de cosseno (operador <=>).
-- HNSW funciona com qualquer nº de linhas (ao contrário do ivfflat, que precisa
-- de dados para treinar as listas). Nesta escala o índice é quase supérfluo,
-- mas ensina o padrão e já escala se o catálogo crescer.
create index datasets_embedding_idx
  on datasets using hnsw (embedding vector_cosine_ops);
