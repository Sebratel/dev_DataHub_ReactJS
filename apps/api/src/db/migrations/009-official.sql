-- Selo "Oficial" (Sprint 8): conjuntos — tipicamente derivados — chancelados
-- pela diretoria como relatório oficial/fonte de verdade. Puramente informativo
-- (não altera permissões de acesso); só admin marca/desmarca.
alter table datasets add column official boolean not null default false;
