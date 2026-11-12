-- api_call_metrics.created_at: DATETIME(6) → TIMESTAMP(6).
--
-- Esta tabela é lida também como FONTE (conexão 'datahub-meta', conjunto
-- "Saúde das APIs"), e fonte entrega e compara data/hora no relógio LOCAL — é o
-- que o Postgres fazia, com a sessão da fonte no fuso do processo. DATETIME não
-- tem fuso: em UTC, a carga incremental compararia o watermark local com a hora
-- UTC (relendo 3 h a cada execução) e a conciliação agruparia os dias em UTC.
-- TIMESTAMP guarda o instante e converte no fuso da SESSÃO, igual ao timestamptz:
-- o app (sessão +00:00) segue lendo e gravando UTC; a fonte (sessão local) vê e
-- compara a hora local. Limite do TIMESTAMP: 2038 — aqui só entra now().
--
-- Feita na sessão do app (+00:00), a conversão preserva o instante de cada linha.
ALTER TABLE api_call_metrics
  MODIFY created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);
