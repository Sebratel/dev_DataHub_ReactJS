-- =============================================================================
-- TÉCNICOS x PRODUTIVIDADE — DETALHE  (conjunto calculado do Data Hub)
--
-- Grão: uma linha por protocolo × papel (INSTALADOR / AUXILIAR).
-- É a tradução para DuckDB da query de produtividade do dbVoalle, com a
-- correção do papel: o mesmo protocolo rende crédito ao instalador E ao
-- auxiliar, em vez de contar o instalador duas vezes.
--
-- Sobre este conjunto roda o agregado (tecnicos-produtividade). Separar os dois
-- é de propósito: o trabalho pesado acontece UMA vez por materialização, e o
-- painel lê um conjunto pequeno. Também deixa o detalhe disponível para somar
-- por equipe, cidade ou período sem reescrever nada.
--
-- ┌─ TODO NÚMERO NESTE LAKE É DOUBLE ────────────────────────────────────────┐
-- │ Medido: assignments.id, assignment_incidents.assignment_id,              │
-- │ incident_types.id e incident_type_id chegam todos como DOUBLE — a        │
-- │ ingestão passa por JSONL e o DuckDB infere ponto flutuante.              │
-- │                                                                          │
-- │ Duas consequências que NÃO dão erro, só resultado errado:                │
-- │   • CAST(id AS VARCHAR) vira "12.0". Comparar com '12' casa ZERO linhas. │
-- │     Foi o que fez esta query voltar vazia na primeira tentativa.         │
-- │   • raspar não-dígitos de "100001.0" devolve 1000010, com um zero a mais.│
-- │ Regra: compare id como NÚMERO (TRY_CAST(... AS BIGINT)), nunca por texto.│
-- └──────────────────────────────────────────────────────────────────────────┘
-- ┌─ ANTES DE SALVAR ────────────────────────────────────────────────────────┐
-- │ 1. Ajuste o bloco MAPEAMENTO abaixo se os slugs do seu lake não forem os │
-- │    nomes físicos (no Data Hub da Sebratel, são — já conferido em tela).  │
-- │ 2. Toda coluna usada aqui precisa estar PUBLICADA como campo do          │
-- │    conjunto. O lake só tem o que foi publicado, não a tabela inteira.    │
-- │ 3. Confira em "Padronizar atualização" se algum destes 10 conjuntos      │
-- │    ainda está em "Precisam de recarga": o corte de 01/01/2026 e as datas │
-- │    finais saem errados enquanto o histórico estiver 3h adiantado.        │
-- └──────────────────────────────────────────────────────────────────────────┘
-- =============================================================================
WITH
-- ═══ MAPEAMENTO PARA O LAKE — o único bloco que você precisa editar ═══
src_assignment_incidents AS (SELECT * FROM assignment_incidents),
src_assignments          AS (SELECT * FROM assignments),
src_incident_types       AS (SELECT * FROM incident_types),
src_schedules            AS (SELECT * FROM schedules),
src_incident_status      AS (SELECT * FROM incident_status),
src_people               AS (SELECT * FROM people),
src_teams                AS (SELECT * FROM teams),
src_ppl_itens            AS (SELECT * FROM patrimony_packing_list_items),
src_ppl                  AS (SELECT * FROM patrimony_packing_lists),
src_reports              AS (SELECT * FROM reports),

base AS (
    SELECT
        a.title                AS solicitacao,
        -- Protocolo como TEXTO limpo. Direto, CAST(protocol AS VARCHAR) daria
        -- "100001.0" — ver a nota sobre DOUBLE no cabeçalho.
        coalesce(CAST(TRY_CAST(ai.protocol AS BIGINT) AS VARCHAR),
                 CAST(ai.protocol AS VARCHAR)) AS protocolo,
        -- Id SEMPRE como número. Comparar id por texto é o erro que zerou a
        -- primeira versão desta query: '12.0' nunca é igual a '12'.
        TRY_CAST(it.id AS BIGINT) AS tipo_id,
        it.title               AS tipo_protocolo,
        is2.title              AS status,
        t.title                AS equipe,
        -- initcap() NÃO existe no DuckDB. Emulação palavra a palavra; nulo
        -- entra e nulo sai, como no Postgres.
        array_to_string(
            list_transform(string_split(lower(p.city), ' '),
                           w -> upper(w[1]) || w[2:]),
            ' ')               AS cidade,
        s.start_date           AS data_agenda,
        -- Chave numérica do protocolo, usada para casar com a tarefa RAUX.
        --
        -- A ORDEM do coalesce é o que importa. Tentar o número primeiro e só
        -- cair no regexp se falhar: com protocolo DOUBLE, raspar não-dígitos
        -- de "100001.0" daria 1000010 — um zero a mais, vindo do ".0". A chave
        -- sairia errada, o auxiliar nunca casaria, e nada acusaria o erro.
        --
        -- '[^0-9]' no lugar de '\D': mesma coisa para o RE2 do DuckDB, e não
        -- vira armadilha se um dia este SQL passar por dentro de código JS,
        -- onde '\D' numa string vira só 'D'.
        coalesce(
            TRY_CAST(ai.protocol AS BIGINT),
            TRY_CAST(NULLIF(regexp_replace(CAST(ai.protocol AS VARCHAR), '[^0-9]', '', 'g'), '') AS BIGINT)
        ) AS chave
    FROM src_assignment_incidents ai
    JOIN src_assignments    a  ON a.id  = ai.assignment_id
    JOIN src_incident_types it ON it.id = ai.incident_type_id
        AND TRY_CAST(it.id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
    LEFT JOIN src_schedules       s   ON s.assignment_id = a.id
    LEFT JOIN src_incident_status is2 ON is2.id = ai.incident_status_id
    LEFT JOIN src_people          p   ON p.id   = a.requestor_id
    LEFT JOIN src_teams           t   ON t.id   = ai.team_id
    WHERE a.created >= TIMESTAMP '2026-01-01'
),

-- Uma linha por solicitação (a agenda mais recente), nos dois ramos.
-- NULLS LAST é explícito porque o padrão do DuckDB e o do Postgres divergem em
-- DESC. Aqui não muda resultado — uma solicitação ou tem agendas (e nenhuma é
-- nula) ou não tem nenhuma (e aí é a única linha) —, mas deixar implícito é
-- confiar numa coincidência.
ramo_instalador AS (
    SELECT *, 'INSTALADOR' AS papel FROM (
        SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.solicitacao ORDER BY b.data_agenda DESC NULLS LAST) AS rn
        FROM base b
    ) x WHERE rn = 1
),
ramo_auxiliar AS (
    SELECT *, 'AUXILIAR' AS papel FROM (
        SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.solicitacao ORDER BY b.data_agenda DESC NULLS LAST) AS rn
        FROM base b
        WHERE b.tipo_id NOT IN (1256, 279)       -- auxiliar não cobre estes dois tipos
    ) x WHERE rn = 1
),
unificado AS (
    SELECT * FROM ramo_instalador
    UNION ALL
    SELECT * FROM ramo_auxiliar
),

-- Quem alocou o patrimônio = técnico da instalação.
alocacao AS (
    SELECT
        a.title       AS solicitacao,
        plis.out_date AS data_saida,
        p3.name       AS alocado_por,
        -- `outsourced` pode chegar booleano, texto ("true") ou número (1/0 —
        -- e no lake, número é DOUBLE). As três formas caem aqui.
        CASE WHEN coalesce(TRY_CAST(CAST(p3.outsourced AS VARCHAR) AS BOOLEAN),
                           TRY_CAST(p3.outsourced AS DOUBLE) <> 0,
                           false)
             THEN 'TERCEIRO' ELSE 'EFETIVO' END AS posicao
    FROM src_ppl_itens plis
    JOIN src_ppl                  ppl ON ppl.id = plis.patrimony_packing_list_id
    JOIN src_assignments          a   ON a.id   = ppl.assignment_id
    JOIN src_assignment_incidents ai  ON ai.assignment_id = a.id
    JOIN src_incident_types       it  ON it.id  = ai.incident_type_id
        AND TRY_CAST(it.id AS BIGINT) IN (12, 1254, 1255, 1014, 1136, 249, 15, 279, 1015)
    LEFT JOIN src_people p3 ON p3.id = plis.person_allocator_id
    WHERE plis.out_date > TIMESTAMP '2026-01-01'
),

-- Técnico da troca de endereço = quem fechou o último relatório do protocolo.
troca AS (
    SELECT tecnico, protocolo, data_troca FROM (
        SELECT
            p.name       AS tecnico,
            coalesce(CAST(TRY_CAST(ai.protocol AS BIGINT) AS VARCHAR),
                     CAST(ai.protocol AS VARCHAR)) AS protocolo,
            r.final_date AS data_troca,
            ROW_NUMBER() OVER (PARTITION BY ai.protocol ORDER BY r.final_date DESC NULLS LAST) AS rn
        FROM src_assignments a
        JOIN src_assignment_incidents ai ON ai.assignment_id = a.id
        JOIN src_incident_types       it ON it.id = ai.incident_type_id
            AND TRY_CAST(it.id AS BIGINT) IN (15, 1256)
        JOIN src_reports r ON r.assignment_id = a.id
        LEFT JOIN src_people p ON p.id = r.person_id
        WHERE r.final_date >= TIMESTAMP '2026-01-01'
          AND (r.description LIKE '%O condomínio é adequado?%'
            OR r.description LIKE '%Foi feita a instalação?%')
    ) x WHERE rn = 1
),

-- Técnico auxiliar: tarefa RAUX filha, com o protocolo dentro das tags.
auxiliar AS (
    SELECT chave_aux, auxiliar FROM (
        SELECT
            coalesce(
                TRY_CAST(r.tags AS BIGINT),
                TRY_CAST(NULLIF(regexp_replace(CAST(r.tags AS VARCHAR), '[^0-9]', '', 'g'), '') AS BIGINT)
            ) AS chave_aux,
            p.name AS auxiliar,
            -- Particiona pelo TEXTO das tags: se o campo vier como lista no
            -- lake, agrupar pela lista crua é instável.
            ROW_NUMBER() OVER (PARTITION BY CAST(r.tags AS VARCHAR) ORDER BY a.final_date DESC NULLS LAST) AS rn
        FROM src_reports r
        JOIN src_assignments          a  ON a.id = r.assignment_id
        JOIN src_assignment_incidents ai ON ai.assignment_id = a.id
        LEFT JOIN src_people          p  ON p.id = r.person_id
        WHERE a.corresponding_parent_id IS NOT NULL
          AND a.assignment_type = 'RAUX'
          AND a.final_date >= TIMESTAMP '2026-01-01'
    ) x WHERE rn = 1
)

SELECT
    u.protocolo,
    u.tipo_protocolo,
    u.equipe,
    u.cidade,
    u.papel,
    al.posicao,
    CASE
        WHEN u.papel = 'AUXILIAR'                         THEN ax.auxiliar
        WHEN u.tipo_protocolo = 'TEC - Troca de Endereço' THEN tr.tecnico
        ELSE al.alocado_por
    END AS tecnico,
    CASE WHEN u.tipo_protocolo = 'TEC - Troca de Endereço'
         THEN CAST(tr.data_troca AS DATE) ELSE CAST(al.data_saida AS DATE) END AS data_final
FROM unificado u
LEFT JOIN alocacao al ON al.solicitacao = u.solicitacao
LEFT JOIN troca    tr ON tr.protocolo   = u.protocolo
LEFT JOIN auxiliar ax ON ax.chave_aux   = u.chave
-- Cancelado sai DEPOIS de escolher a agenda mais recente, como no relatório.
WHERE u.status IS DISTINCT FROM 'Cancelado'
