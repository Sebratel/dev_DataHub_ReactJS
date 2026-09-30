-- Pausa automática depois de falhas seguidas.
--
-- O agendador reenfileira um conjunto vencido a cada ciclo, sem olhar se a
-- execução anterior deu certo. Num erro TRANSITÓRIO isso é exatamente o que se
-- quer: a próxima tentativa passa. Num erro DETERMINÍSTICO, vira laço.
--
-- Aconteceu: um conjunto de 15,9 milhões de linhas abortava sempre no mesmo
-- ponto e era tentado de novo a cada ~3h — 7 varreduras por dia contra o ERP de
-- produção, cada uma lendo por horas para nunca concluir, e cada uma enchendo e
-- esvaziando ~20 pontos de disco. Ninguém era avisado; o padrão só apareceu
-- quando alguém cruzou o gráfico do servidor com o histórico de execuções.
--
-- A regra: N falhas seguidas pausam o AGENDAMENTO do conjunto. Não mexemos na
-- cadência que a pessoa configurou — isso seria apagar a intenção dela e
-- obrigar a reconfigurar depois. A pausa é um estado à parte, que o agendador
-- respeita e qualquer ação humana explícita (sincronizar agora, recarregar,
-- salvar a configuração) limpa: se alguém foi lá e mandou rodar, é porque
-- acredita que o motivo mudou.
alter table datasets
  -- Falhas consecutivas. Zera em toda execução bem-sucedida.
  add column sync_failures int not null default 0,
  -- Preenchido = o agendador ignora este conjunto. O texto diz por quê, porque
  -- "não está atualizando e não dá erro" é o pior estado possível para depurar.
  add column sync_paused_reason text;
