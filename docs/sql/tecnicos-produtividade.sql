-- =============================================================================
-- TÉCNICOS x PRODUTIVIDADE — AGREGADO POR MÊS  (conjunto calculado do Data Hub)
--
-- Reproduz a tabela PROTOCOLOS PRODUTIVIDADE do Power BI, com uma coluna de
-- mês para dar recorte de período.
--
-- Lê o conjunto calculado de DETALHE — não as fontes. É por isso que ele é
-- barato: todo o trabalho pesado (10 junções e quatro janelas) já aconteceu
-- uma vez, na materialização do detalhe.
--
-- Grão: técnico × mês. Com ~96 técnicos e um ano de histórico, são ~1.000
-- linhas — continua instantâneo, e agora dá para filtrar "mês atual".
--
-- ┌─ COMO SOMAR VÁRIOS MESES ────────────────────────────────────────────────┐
-- │ `protocolos`, `como_instalador`, `como_auxiliar` e `dias_trabalhados`    │
-- │ SOMAM entre meses. Um protocolo tem uma única data final, então pertence │
-- │ a exatamente um mês; e um dia não está em dois meses. Não há dupla       │
-- │ contagem.                                                                │
-- │                                                                          │
-- │ `media_por_dia` NÃO soma e NÃO se tira média de média — num período de   │
-- │ vários meses ela é   sum(protocolos) / sum(dias_trabalhados).            │
-- │ A média das médias mensais dá outro número, e sempre a favor dos meses   │
-- │ curtos: quem trabalhou 2 dias em janeiro pesaria igual a quem trabalhou  │
-- │ 20 em fevereiro.                                                         │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- Protocolo SEM data final cai num grupo com `mes` nulo, em vez de sumir.
-- Se esse grupo vier grande, é sinal de que a alocação de patrimônio não está
-- casando — não de que o técnico não trabalhou.
--
-- Ajuste `tecnicos_produtividade_detalhe` para o slug real do conjunto de
-- detalhe, com underscore. Cadência recomendada: AUTOMÁTICA (cascata) — ele
-- recalcula sozinho assim que o detalhe terminar, e custa quase nada.
--
-- Para o total do período inteiro, sem recorte: tire `mes` e `competencia` do
-- SELECT e do GROUP BY. O resto não muda.
--
-- Não traz o GESTOR: no dashboard isso vem da planilha QUADRO FUNCIONAL, não
-- do banco. Para tê-lo aqui, publique a planilha como conjunto e junte por
-- técnico num terceiro calculado.
-- =============================================================================
SELECT
    upper(tecnico)                                                AS tecnico,
    -- Primeiro dia do mês, como DATA (date_trunc devolve timestamp, e um
    -- "2026-10-01 00:00:00" numa coluna de mês só polui a tela). Filtra e
    -- ordena como data de verdade: mes >= '2026-10-01'.
    CAST(date_trunc('month', data_final) AS DATE)                 AS mes,
    -- Rótulo pronto para eixo de gráfico e para filtro em lista.
    strftime(data_final, '%Y-%m')                                 AS competencia,
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
GROUP BY upper(tecnico), CAST(date_trunc('month', data_final) AS DATE), strftime(data_final, '%Y-%m')
-- Sem ORDER BY: a saída é materializada em Parquet e a ordenação não se
-- preserva. Ordene na tela (as colunas de Conjuntos e dos painéis ordenam).
