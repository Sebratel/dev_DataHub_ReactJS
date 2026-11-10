-- ─────────────────────────────────────────────────────────────────────────
-- Registro de USO (MON-01 e D-DSP-2 do comitê).
--
-- Consultar um conjunto, abrir um painel, rodar um notebook ou chamar a API
-- por token não deixava rastro nenhum. Sem isso não dá para responder "quem
-- usa este conjunto?", e a regra de arquivar o calculado sem uso em 90 dias
-- (D-DSP-2) não tem como começar a contar.
--
-- Uma linha por DIA × recurso × quem × por onde, com contador. Não é uma
-- linha por consulta: um painel com 15 widgets dispara 15 consultas a cada
-- abertura, e isso gravado um a um afogaria a auditoria. A primeira vez do dia
-- de cada combinação vai TAMBÉM para audit_logs (feito no código), então a
-- Auditoria mostra o acesso sem repetir a mesma linha 200 vezes.
--
-- Sem chave estrangeira para datasets/dashboards de propósito: o histórico de
-- uso precisa sobreviver à exclusão do recurso (é o rastro do que existiu).
--
--   actor: e-mail da pessoa, ou 'token:<id da credencial>' na API pública.
--   via:   'query' | 'export' | 'notebook' | 'dashboard' | 'ai' | 'api'.
-- ─────────────────────────────────────────────────────────────────────────
create table usage_daily (
  tenant_id uuid not null references tenants(id),
  day date not null,
  resource_type text not null,
  resource_id uuid not null,
  actor text not null,
  via text not null,
  hits int not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (tenant_id, day, resource_type, resource_id, actor, via)
);

-- "Último uso deste recurso" e "uso nos últimos N dias" leem por recurso.
create index usage_daily_resource_idx on usage_daily (resource_type, resource_id, day desc);
