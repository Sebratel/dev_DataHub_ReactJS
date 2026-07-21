-- Sprint 9: "ponto de partida" (cutoff) para a carga incremental. Em tabelas
-- enormes (ex.: 16 mi de linhas), publicar TUDO é inviável. Este piso define a
-- partir de qual valor da CHAVE INCREMENTAL a primeira carga começa — ex.:
-- incremental_key = 'modified', sync_since = '2026-01-01' → só ~3 mi de linhas.
--
-- Semântica: usado APENAS quando ainda não há watermark (primeira carga). Depois
-- que o watermark é gravado, ele assume e o piso deixa de importar (ver ingest).
alter table datasets add column sync_since text;
