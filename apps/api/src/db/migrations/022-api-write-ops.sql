-- APIs de escrita: além de INSERT (POST), agora UPDATE (PUT/PATCH) e DELETE.
-- write_op define a operação; key_columns é a ALLOWLIST do WHERE (obrigatório em
-- update/delete — sem WHERE varreria a tabela inteira); max_affected é o teto de
-- linhas afetadas (a operação roda em transação e faz ROLLBACK se exceder).
alter table api_products add column write_op text;      -- 'insert' | 'update' | 'delete'
alter table api_products add column key_columns jsonb;  -- [{ col, type }] usados no WHERE
alter table api_products add column max_affected int;   -- null = sem teto (WHERE ainda é obrigatório)

-- Os produtos de escrita existentes eram todos INSERT.
update api_products set write_op = 'insert' where kind = 'write' and write_op is null;
