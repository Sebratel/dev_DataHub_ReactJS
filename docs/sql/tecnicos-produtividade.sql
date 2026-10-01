-- =============================================================================
-- TÉCNICOS x PRODUTIVIDADE — AGREGADO  (conjunto calculado do Data Hub)
--
-- Reproduz a tabela PROTOCOLOS PRODUTIVIDADE do Power BI.
-- Lê o conjunto calculado de DETALHE — não as fontes. É por isso que ele é
-- barato: todo o trabalho pesado (10 junções e quatro janelas) já aconteceu
-- uma vez, na materialização do detalhe.
--
-- Produtividade = protocolos DISTINTOS por técnico.
-- Média/dia     = protocolos ÷ dias distintos com instalação (data_final).
--
-- Ajuste `tecnicos_produtividade_detalhe` para o slug real do conjunto de
-- detalhe, com underscore. Cadência recomendada: AUTOMÁTICA (cascata) — ele
-- recalcula sozinho assim que o detalhe terminar, e custa quase nada.
--
-- Não traz o GESTOR: no dashboard isso vem da planilha QUADRO FUNCIONAL, não
-- do banco. Para tê-lo aqui, publique a planilha como conjunto e junte por
-- técnico num terceiro calculado.
-- =============================================================================
SELECT
    upper(tecnico)                                                AS tecnico,
    count(DISTINCT protocolo)                                     AS protocolos,
    count(DISTINCT protocolo) FILTER (WHERE papel = 'INSTALADOR') AS como_instalador,
    count(DISTINCT protocolo) FILTER (WHERE papel = 'AUXILIAR')   AS como_auxiliar,
    count(DISTINCT data_final)                                    AS dias_trabalhados,
    -- ::DOUBLE e não ::numeric: no DuckDB o NUMERIC padrão é DECIMAL(18,3) e
    -- a divisão perde casas antes do ROUND.
    round(count(DISTINCT protocolo)::DOUBLE
          / nullif(count(DISTINCT data_final), 0), 2)             AS media_por_dia
FROM tecnicos_produtividade_detalhe
WHERE tecnico IS NOT NULL
GROUP BY upper(tecnico)
-- Sem ORDER BY: a saída é materializada em Parquet e a ordenação não se
-- preserva. Ordene na tela (as colunas de Conjuntos e dos painéis ordenam).
