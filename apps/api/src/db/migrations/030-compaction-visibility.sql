-- Compactação: tornar VISÍVEL o que ela custa, e deixar de pagar esse custo
-- quando não há o que compactar.
--
-- A compactação é o que transforma "só acrescenta" em "atualiza ou cria": ela
-- reescreve o conjunto INTEIRO mantendo, por identidade, só a linha mais
-- recente. Num agendamento de 5 em 5 minutos, "o conjunto inteiro" é
-- reescrito até 288 vezes por dia — e na maioria dessas vezes o lote trouxe
-- apenas linhas NOVAS, sem nenhuma identidade repetida para colapsar. O
-- trabalho pesado (ler todas as colunas, recomprimir em zstd, gravar de novo)
-- acontecia do mesmo jeito.
--
-- A partir daqui a compactação é CONDICIONAL (ver ingest.ts) e cada execução
-- registra o que decidiu. Sem esse registro não há como responder a pergunta
-- que motivou tudo isto — "o que está consumindo disco e CPU do servidor?" —
-- senão por suposição.
alter table sync_runs
  -- true = esta execução reescreveu o conjunto; false = pulou (nada a juntar).
  add column compacted boolean not null default false,
  -- Tempo só da compactação, separado do tempo de leitura da fonte. É o número
  -- que diz se cabe baixar a cadência deste conjunto para minutos.
  add column compact_ms int,
  -- Quantos arquivos Parquet o conjunto tinha ao fim da execução. Subindo sem
  -- parar = muitos lotes pequenos acumulando (leitura fica mais lenta a cada um).
  add column parts int;
