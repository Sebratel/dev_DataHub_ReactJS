-- Dashboards ricos: ABAS + canvas livre (x/y/w/h) + estilo/personalização de
-- widget. Evolui o modelo antigo (grade fixa sm/md/lg) SEM perder nada — cada
-- dashboard existente ganha uma aba "Geral" e todos os seus widgets migram
-- para ela. As colunas novas são anuláveis (o render usa defaults quando null),
-- então o front antigo continua funcionando até a Fase 2 assumir o canvas.

create table dashboard_tabs (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  label text not null default 'Geral',
  icon text,                                  -- nome do ícone lucide (opcional)
  sort_order int not null default 0,
  config jsonb,                               -- filtros por aba / auto-refresh (Fase 5)
  created_at timestamptz not null default now()
);
create index dashboard_tabs_dashboard_idx on dashboard_tabs (dashboard_id, sort_order);

-- Widget agora pertence a uma ABA (além do dashboard, mantido para as queries
-- e o cascade existentes). layout = posição livre no grid de 12 colunas;
-- style = personalização visual (cores, rótulos, meta, formatação condicional).
alter table widgets add column tab_id uuid references dashboard_tabs(id) on delete cascade;
alter table widgets add column layout jsonb;  -- {x,y,w,h}; null = auto-flow no cliente
alter table widgets add column style jsonb;   -- WidgetStyle (Fase 3); null = defaults

-- Configuração do dashboard como um todo (tema/paleta/modo TV) — Fase 5.
alter table dashboards add column settings jsonb;

-- ── Backfill (idempotente na prática: roda uma vez, na migração) ──────────────
-- 1) Uma aba "Geral" por dashboard.
insert into dashboard_tabs (dashboard_id, label, sort_order)
select id, 'Geral', 0 from dashboards;

-- 2) Vincula todo widget existente à aba "Geral" do seu dashboard.
update widgets w
   set tab_id = t.id
  from dashboard_tabs t
 where t.dashboard_id = w.dashboard_id and w.tab_id is null;

create index widgets_tab_idx on widgets (tab_id, sort_order);
