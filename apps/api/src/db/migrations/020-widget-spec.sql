-- Widgets ricos (paridade com o dashboards_IA): modelo de dados mais completo.
-- `spec` guarda o que o modelo antigo (uma dimensão + uma medida) não cobria:
-- múltiplas dimensões (agrupamento composto), múltiplas medidas (cada uma vira
-- série), dimensão de legenda (pivô em séries), medida do eixo X (dispersão),
-- conteúdo de texto, Top N e filtro fixo do widget. As colunas antigas
-- (dimension/metric) seguem preenchidas com a 1ª dimensão/medida (fallback).
alter table widgets add column spec jsonb;

-- O tipo "Texto" não consulta dado nenhum → pode não ter conjunto.
alter table widgets alter column dataset_id drop not null;
