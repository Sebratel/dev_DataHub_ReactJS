-- ─────────────────────────────────────────────────────────────────────────
-- Qualidade dos dados: conciliação fonte × lake e alertas.
--
-- A R4 do comitê (30/10/2026) decidiu a D-QLD-3: uma vez por dia o sistema
-- escolhe um conjunto pequeno, um médio e um grande e confere com a fonte —
-- contagem e soma, separadas por dia quando o conjunto tem chave de data. Até
-- aqui a contagem "oficial" vinha do próprio lake (QLD-02): uma linha perdida
-- no caminho só aparecia quando alguém estranhava o número. Os 12 defeitos de
-- qualidade já corrigidos (§5.4) foram todos achados assim.
--
-- E o princípio aprovado na mesma reunião (P-QLD-2, "falha visível, nunca
-- silenciosa") pede que a divergência chegue a alguém sem depender de uma
-- tela aberta — daí as duas tabelas de alerta (MON-03).
-- ─────────────────────────────────────────────────────────────────────────

create table reconcile_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  -- 'daily' = escolhido pela rotina diária; 'manual' = "Conciliar agora".
  trigger text not null check (trigger in ('daily', 'manual')),
  -- Faixa de tamanho no momento do pedido (pequeno/médio/grande da D-QLD-3).
  band text check (band in ('small', 'medium', 'large')),
  -- 'queued' espera a carga que vem antes da conferência; 'match' e
  -- 'diverged' são os dois resultados; 'error' é conferência que não chegou
  -- ao fim (fonte fora, tempo esgotado, carga anterior falhou).
  status text not null default 'queued'
    check (status in ('queued', 'running', 'match', 'diverged', 'error')),
  -- 'per-day' separa por dia da chave de data; 'total' compara só o total
  -- (snapshot, ou chave incremental numérica).
  method text check (method in ('per-day', 'total')),
  key_field text,                 -- campo (key) que separa por dia / limita o total
  sum_field text,                 -- campo (key) somado; null = só contagem
  -- Limites da comparação, no formato que as fontes entendem (hora local).
  window_from text,
  window_to text,
  source_rows bigint,
  lake_rows bigint,
  source_sum double precision,
  lake_sum double precision,
  days_compared int,
  days_diverged int,
  -- Até 60 dias que não bateram: [{day, sourceRows, lakeRows, sourceSum, lakeSum}].
  diff_days jsonb,
  -- Linhas que existem na fonte e NUNCA entram no lake: chave de criação (e
  -- de edição, se houver) vazias — o keyset só avança sobre valores não nulos
  -- (QLD-07). Contam como divergência.
  lost_rows bigint,
  -- Observações que explicam o resultado sem mudá-lo (janela, só contagem…).
  notes jsonb not null default '[]',
  error text,
  requested_by text,
  source_ms int,                  -- tempo das consultas na fonte
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index reconcile_runs_dataset_idx on reconcile_runs (dataset_id, created_at desc);
create index reconcile_runs_created_idx on reconcile_runs (created_at desc);
-- No máximo UMA conciliação pendente por conjunto: um segundo clique em
-- "Conciliar agora" enquanto a primeira espera a fila não pode gerar outra
-- leitura da fonte para chegar ao mesmo número.
create unique index reconcile_runs_one_pending_idx
  on reconcile_runs (dataset_id) where status in ('queued', 'running');

-- Para onde vão os alertas. Um canal por tenant: um webhook que recebe
-- {"text": "..."} — o formato do Google Chat, que o Slack e um fluxo do n8n
-- também aceitam. O endereço do webhook É a credencial (quem o tem posta no
-- espaço), então fica cifrado como as senhas de conexão e nunca volta inteiro
-- numa resposta da API.
create table alert_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  webhook_enc text,
  webhook_hint text,              -- host + 4 últimos caracteres, só para reconhecer
  enabled boolean not null default true,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Todo alerta que o sistema quis mandar, tenha saído ou não. 'no-channel'
-- existe de propósito: sem webhook cadastrado o aviso continua registrado e
-- visível na tela, em vez de sumir.
create table alert_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- Identidade do assunto (ex.: 'reconcile:diverged:<dataset>'): o mesmo
  -- assunto não é reenviado dentro da janela de silêncio.
  key text not null,
  kind text not null,
  title text not null,
  body text not null,
  status text not null check (status in ('sent', 'failed', 'no-channel')),
  error text,
  created_at timestamptz not null default now()
);
create index alert_events_key_idx on alert_events (tenant_id, key, created_at desc);
create index alert_events_created_idx on alert_events (tenant_id, created_at desc);
