-- Conexões de fonte GERENCIÁVEIS pela tela (self-service), além das fixas do
-- .env (registry). A senha é guardada CRIPTOGRAFADA (AES-256-GCM) e NUNCA é
-- exposta ao frontend nem gravada em claro. Requer CONNECTIONS_SECRET no
-- ambiente para (de)criptografar.
create table source_connections (
  id text primary key,                -- slug estável; referenciado por datasets.connection_id
  name text not null,
  kind text not null check (kind in ('postgres', 'mysql')),
  host text not null,
  port int not null,
  "database" text not null,
  username text not null,
  password_enc text not null,         -- iv:tag:ciphertext (base64) — nunca em claro
  ssl boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
