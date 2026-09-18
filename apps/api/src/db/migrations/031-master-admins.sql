-- Admin master concedido pela TELA, não só pelo ambiente.
--
-- Até aqui a lista de masters vinha só de MASTER_ADMIN_EMAILS (ambiente da
-- stack). Isso garantia a propriedade que importa — ninguém se promove por
-- dentro do sistema — mas custava um deploy para incluir uma pessoa.
--
-- O desenho passa a ter DUAS origens, com papéis diferentes:
--
--   • AMBIENTE (MASTER_ADMIN_EMAILS) = raiz de confiança. Não é editável pela
--     tela, em nenhuma hipótese. É o caminho de recuperação: se alguém revogar
--     masters demais, ou se um master delegado for comprometido, quem está no
--     ambiente continua entrando e conserta. Por isso a tela mostra esses
--     e-mails como fixos, sem botão de remover.
--
--   • ESTA TABELA = delegação. Um master concede a outra pessoa sem deploy.
--
-- A regra que sustenta tudo: **só um master concede master**. Se um admin
-- comum pudesse, a restricao das fontes nao valeria nada — qualquer admin ja
-- pode conceder 'admin' a si mesmo em PATCH /users/:email/role, e bastaria
-- repetir o truque um degrau acima. Por isso master NÃO entra na tabela
-- `roles`/`user_roles`: aquele caminho é administrado por 'admin', e uma linha
-- de master ali seria concedível por quem não deveria.
create table master_admins (
  -- E-mail e a identidade em todo o hub (users.email e unique).
  email text primary key,
  -- Quem concedeu, para a auditoria responder "desde quando, e por quem".
  granted_by text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
