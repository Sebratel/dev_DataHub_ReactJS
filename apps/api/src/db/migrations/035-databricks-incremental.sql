-- Envio incremental e envio pulado: as duas coisas que faltavam para o piloto
-- não reenviar o mesmo dado 13 vezes por dia.
--
-- Em SNAPSHOT, cada ciclo manda o conjunto inteiro. Com os oito conjuntos da
-- fase 1 ligados são ~1,5 milhão de linhas por ciclo, ~20 milhões por dia, e a
-- tabela é reescrita 13 vezes — quase tudo para produzir um resultado idêntico
-- ao anterior. Não é um problema de desempenho: é fatura.

-- Impressão digital do arquivo CONSOLIDADO do último envio bem-sucedido.
--
-- A consolidação é determinística de propósito (dedup estável + ordenação), o
-- que torna o hash uma resposta confiável para "mudou alguma coisa?". Se não
-- mudou, o envio é pulado: o custo local de consolidar permanece (é barato e
-- roda no nosso servidor), e some o que custa do outro lado — upload e,
-- principalmente, o job de carga.
alter table databricks_sync_runs add column content_sha256 text;

-- Os arquivos do lake que entraram neste envio.
--
-- É assim que o modo incremental sabe o que é novo, sem inventar um watermark
-- paralelo: o lake JÁ produz uma parte por execução. Comparar o conjunto de
-- nomes entre dois envios responde tudo —
--
--   • surgiram partes novas e as velhas continuam lá → manda só as novas;
--   • alguma parte conhecida sumiu → houve compactação ou recarga, e o
--     conjunto foi reescrito: manda tudo, porque o delta perdeu o sentido.
--
-- Guardar os nomes (e não um contador) é o que permite distinguir esses dois
-- casos. Um contador diria "eram 4, agora são 1" sem dizer se é compactação ou
-- perda de arquivo.
alter table databricks_sync_runs add column source_files text[];

-- Em que modo este envio FOI feito, que nem sempre é o configurado: um
-- conjunto em INCREMENTAL manda tudo quando a compactação reescreve o lake. A
-- coluna `mode` guarda a intenção; esta guarda o que aconteceu.
alter table databricks_sync_runs add column effective_mode text;
alter table databricks_sync_runs add constraint databricks_runs_effective_mode_check
  check (effective_mode is null or effective_mode in ('SNAPSHOT', 'INCREMENTAL'));
