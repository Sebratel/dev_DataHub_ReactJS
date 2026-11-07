-- ─────────────────────────────────────────────────────────────────────────
-- Conciliação: além de "diverge", dizer POR QUE e o que fazer.
--
-- "Conciliar agora" conferia de novo e devolvia o mesmo número, e a pessoa
-- concluía que o botão não fazia nada. Conferir nunca conserta: o que
-- conserta depende da causa (linha repetida no lake, apagada na fonte ou
-- faltando no lake), e a causa se descobre no próprio lake, sem tocar na fonte.
--
--   lake_dup   linhas repetidas no lake pela identidade (ou, sem ela, pelo
--              campo da soma de controle), na mesma janela da contagem
--   diagnosis  a causa provável e o conserto, em uma frase para quem lê
-- ─────────────────────────────────────────────────────────────────────────

alter table reconcile_runs
  add column lake_dup bigint,
  add column diagnosis text;
