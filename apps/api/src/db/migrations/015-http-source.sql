-- Fonte HTTP (API GET): a CONEXÃO ganha `config` (baseUrl, header de auth) e o
-- DATASET ganha `source_config` (endpoint, params, recordsPath, paginação).
-- O token reusa password_enc (criptografado). As colunas de banco viram
-- opcionais (http não usa host/porta/database/username).
alter table source_connections
  drop constraint source_connections_kind_check,
  add constraint source_connections_kind_check check (kind in ('postgres', 'mysql', 'http')),
  add column config jsonb,
  alter column host drop not null,
  alter column port drop not null,
  alter column "database" drop not null,
  alter column username drop not null,
  alter column password_enc drop not null; -- http sem auth pode não ter token

-- Endpoint/paginação da API para datasets cuja fonte é uma conexão http.
alter table datasets add column source_config jsonb;
