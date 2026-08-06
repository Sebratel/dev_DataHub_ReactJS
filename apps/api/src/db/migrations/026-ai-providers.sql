-- ─────────────────────────────────────────────────────────────────────────
-- Provedores de IA gerenciados pela plataforma.
--
-- Até aqui a chave da IA vivia no .env: trocar de modelo ou rotacionar a chave
-- exigia editar a stack e redeployar, e só quem tinha acesso ao servidor
-- conseguia fazer. Agora o provedor é cadastrado na tela, a chave é cifrada em
-- repouso e a troca é imediata.
--
-- A chave NUNCA volta numa resposta da API — nem mascarada de forma reversível.
-- A tela mostra apenas os últimos 4 caracteres, guardados em claro de propósito
-- para dar reconhecimento ("é a chave que termina em 4f2a?") sem expor o segredo.
-- ─────────────────────────────────────────────────────────────────────────

create table ai_providers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,                     -- rótulo do usuário: "Claude de produção"

  -- 'anthropic' | 'openai' | 'gemini'
  -- 'openai' fala o dialeto Chat Completions, então cobre também Azure OpenAI,
  -- Groq, OpenRouter, Together e servidores locais compatíveis — basta trocar
  -- a base_url. É por isso que o campo se chama kind e não "vendor".
  kind text not null,
  model text not null,

  api_key_enc text,                       -- AES-256-GCM (core/crypto)
  key_hint text,                          -- últimos 4 caracteres, só para reconhecimento
  base_url text,                          -- endpoint alternativo (compatíveis com OpenAI)

  -- Ajustes de geração. max_tokens generoso de propósito: resposta cortada no
  -- meio é o modo de falha mais comum e mais confuso para quem usa.
  max_tokens int not null default 16000,
  -- Só Anthropic e alguns modelos usam; guardado como texto livre para não
  -- precisar de migration a cada nível novo ('low' | 'medium' | 'high' | …).
  effort text,

  enabled boolean not null default true,
  is_default boolean not null default false,

  -- Resultado do último teste de conexão — o que diz se o cadastro presta.
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  last_test_ms int,

  owner_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index ai_providers_tenant_idx on ai_providers (tenant_id, enabled);

-- No máximo UM padrão por tenant. Índice parcial em vez de trigger: o banco
-- garante a regra sozinho, e uma corrida entre duas telas vira erro de
-- constraint em vez de dois provedores "padrão" ao mesmo tempo.
create unique index ai_providers_one_default_idx
  on ai_providers (tenant_id) where is_default;
