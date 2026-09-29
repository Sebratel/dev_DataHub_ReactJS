# Treinamento — Atualização das fontes no Data Hub

**Para quem:** administrador do Data Hub que vai **aplicar** ou **validar** a
padronização da atualização dos conjuntos de dados.

**Pré-requisito:** ter papel de *Administrador* no hub. Algumas ações exigem
*administrador master* — a seção [9](#9-quem-pode-o-quê) diz quais e por quê.

**Ao final você consegue:** ler o diagnóstico de um conjunto, decidir se a regra
proposta está certa, aplicar, destravar um conjunto parado e dizer com
segurança se o resultado ficou correto.

> Este documento é sobre **decidir e validar**. Para incidentes (disco cheio,
> carga em fuga, variáveis de proteção), o guia é o [RUNBOOK](./RUNBOOK.md).

---

## Sumário

1. [O problema que isso resolve](#1-o-problema-que-isso-resolve)
2. [Seis conceitos](#2-seis-conceitos)
3. [As telas](#3-as-telas)
4. [Roteiro A — padronizar um conjunto](#4-roteiro-a--padronizar-um-conjunto)
5. [Roteiro B — destravar um conjunto parado](#5-roteiro-b--destravar-um-conjunto-parado)
6. [Roteiro C — cadência de minutos](#6-roteiro-c--cadência-de-minutos)
7. [Checklist de validação](#7-checklist-de-validação)
8. [Erros e o que significam](#8-erros-e-o-que-significam)
9. [Quem pode o quê](#9-quem-pode-o-quê)
10. [Como sugiro conduzir](#10-como-sugiro-conduzir)
11. [Glossário](#11-glossário)

---

## 1. O problema que isso resolve

O hub lê das bases de produção (ELLEVEN, RADIUS, AutoISP, Massivas) e guarda uma
cópia em Parquet — o **lake**. Todas as consultas de usuário batem no lake,
nunca na produção. A pergunta operacional é sempre a mesma:

> **Com que frequência dá para atualizar o lake sem pesar na produção?**

Até aqui a resposta era conservadora: quase tudo em *snapshot* (recarrega a
tabela inteira) uma vez por dia, de madrugada. Funciona, mas tem dois custos:

- **dado velho** — um painel consultado às 15h mostra o mundo das 3h;
- **carga concentrada** — recarregar tudo é a operação mais cara que existe, e
  ela acontece justamente quando ninguém está olhando para reagir.

A alternativa é o **incremental**: ler só o que mudou desde a última vez. É mais
barato por execução, o que permite rodar de minuto em minuto. Mas exige acertar
três coisas por tabela — qual coluna marca o que é novo, qual marca o que foi
editado, e o que identifica uma linha. Fazer isso à mão, conjunto a conjunto,
para dezenas de tabelas, é o que nunca aconteceu.

**O que mudou:** o hub agora **lê o catálogo do banco de origem** (chave
primária, índices únicos, cobertura de índice) e **propõe** essa configuração
para cada conjunto, com o motivo e os riscos. Você confere e aplica — em lote.

---

## 2. Seis conceitos

Leia esta seção uma vez. É o que permite discordar da proposta quando ela
estiver errada — e ela vai estar errada em alguns casos.

### 2.1 Snapshot × Incremental

| | Snapshot | Incremental |
|---|---|---|
| O que lê | a tabela inteira, toda vez | só o que passou do último marco |
| Custo na fonte | alto e constante | baixo, se a chave tiver índice |
| Cadência viável | diária | minutos |
| Precisa de | nada | chave crescente (data ou id) |

O marco é o **watermark**: o maior valor da chave que o hub já leu. Na execução
seguinte ele pede `WHERE chave > watermark`.

### 2.2 Por que DUAS chaves

A maioria das tabelas tem duas colunas de data: uma de criação (`created_at`,
`data_cadastro`) e uma de edição (`updated_at`, `data_alteracao`). Escolher uma
só sempre perde alguma coisa:

- **só `created`** → uma linha editada nunca volta. O lake fica com a versão
  antiga para sempre.
- **só `modified`** → em quase toda tabela essa coluna **só é preenchida quando
  houve edição**. Linha nunca editada tem `modified` vazio, e em SQL
  `NULL > qualquer-coisa` é falso. Ou seja: **toda linha nunca editada é
  descartada em silêncio**. Este é o erro mais caro e o mais difícil de notar —
  não dá erro, só falta dado.

Por isso o hub faz **duas passadas**, uma por chave, cada uma com seu próprio
watermark. Cada passada ordena pela sua coluna e continua usando o índice dela.

> **Por que não `ORDER BY greatest(created, modified)`?** Porque uma expressão
> não usa índice: viraria varredura completa da tabela a cada lote, contra a
> produção, a cada poucos minutos. Exatamente o que queremos evitar.

**E quando a tabela só tem a data de EDIÇÃO?** Aí a 1ª chave vira o `id`
numérico (que faz o papel de "linha nova") e a 2ª continua sendo `updated_at`.
É uma combinação legítima e comum — mas repare que, nesse arranjo, a **folga de
reconferência** é a única proteção contra uma edição com carimbo retroativo
cair atrás do corte. O diagnóstico já propõe 10 minutos nesse caso; não zere
sem motivo.

**E quando a tabela não tem data nenhuma?** Aí a chave pode ser uma coluna
numérica crescente — mas ela precisa ser **única por linha**, e isso o hub
confere no catálogo (chave primária de uma coluna só, ou índice único de uma
coluna só). Nome com cara de identificador não basta: `id_agente`, primeira
coluna de uma chave composta, repete a cada registro do mesmo agente. Numa
leitura incremental isso **não dá erro — pula linhas**: o corte avança para o
valor repetido e o resto do grupo é descartado. Quando não há coluna
comprovadamente única, o diagnóstico prefere não propor nada.

### 2.3 Identidade da linha

As duas passadas **se sobrepõem de propósito**: uma linha criada *e* editada na
mesma janela vem nas duas. Se nada juntar as pontas, ela entra duplicada.

A **identidade da linha** é o campo (ou a combinação) que diz "esta linha é a
mesma daquela" — quase sempre a chave primária. Com ela definida, o hub
**substitui** a versão antiga pela mais recente. Sem ela, apenas **acrescenta**.

> ⚠️ **Na primeira sincronização com identidade definida, o total de linhas do
> conjunto VAI CAIR.** Isso é o conserto, não perda: as versões antigas que
> vinham se acumulando são colapsadas. **Não reverta achando que quebrou.**

### 2.4 A cadência depende do índice

Uma passada incremental é `WHERE chave > X ORDER BY chave LIMIT n`. Isso é
barato **se a chave for a primeira coluna de algum índice** na tabela de origem.
Se não for, o banco varre a tabela inteira a cada lote.

Faça a conta: um conjunto a cada 5 minutos são **288 execuções por dia**. Com
índice, são 288 leituras baratas. Sem índice, são 288 varreduras completas da
tabela — contra a produção, todo dia.

Por isso o diagnóstico **rebaixa a cadência recomendada para "de hora em hora"
quando a chave não tem índice**, e avisa. A saída correta não é ignorar o aviso:
é pedir o índice à equipe do banco e, aí sim, subir a cadência.

**Views** também ficam em "de hora em hora", mesmo parecendo perfeitas: o custo
real é o da consulta por trás delas, que o diagnóstico não enxerga.

### 2.5 Fuso horário: o lake guarda hora LOCAL

Todo horário no lake é **hora local de Brasília**, igual ao que a tabela de
origem mostra. Não há conversão para UTC em lugar nenhum do caminho — os
drivers entregam a data como texto e quem converte é o DuckDB, uma vez só.

Isso importa na hora de validar: se um horário no lake estiver **3 horas
adiantado** em relação à fonte, não é arredondamento nem atraso de
sincronização — é defeito de conversão, e vale abrir chamado. Até 28/09/2026
era o que acontecia com toda fonte Postgres.

> O mesmo defeito tinha um efeito pior e invisível: o corte do incremental
> (watermark) ficava 3 horas no futuro, e as linhas criadas nesse intervalo
> nunca eram lidas. Conjunto que "parou de receber linhas novas mas não dá
> erro" é o sintoma — confira o horário antes de suspeitar da cadência.

### 2.6 Compactação

Substituir a versão antiga de uma linha significa **reescrever o conjunto**.
Fazer isso a cada execução, 288 vezes por dia, é caro em disco e CPU — e na
maioria das vezes desnecessário, porque o lote só trouxe linhas novas.

O hub agora **pergunta antes**: só reescreve quando existe identidade repetida
para colapsar, ou quando o número de arquivos passa do teto. Por isso o
histórico de execuções mostra, na coluna **Compactação**:

- `dispensada` — o caso bom e mais comum: nada a juntar;
- `1.234 ms` — reescreveu, e quanto custou;
- `· 7 arq.` — quantos arquivos Parquet o conjunto tem.

Se um conjunto compacta **em toda execução** e demora muito, é sinal de que ele
recebe muita edição — vale olhar se a cadência está agressiva demais.

---

## 3. As telas

### 3.1 Administração › Padronizar atualização

É a tela principal. Ela lê o catálogo de cada tabela de origem e monta uma
proposta por conjunto.

> A leitura demora alguns segundos: é uma consulta de catálogo por conjunto,
> feita **uma de cada vez** de propósito — o hub nunca abre várias conexões
> simultâneas contra a produção.

**Os filtros, na ordem em que aparecem:**

| Filtro | O que junta | Prioridade |
|---|---|---|
| **Não estão atualizando** | conjuntos falhando ou com campo apontando para coluna inexistente | 🔴 resolva primeiro |
| **Todos** | tudo | — |
| **Prontos para aplicar** | proposta de confiança alta, sem nenhum aviso | ✅ aplique em lote |
| **Conferir antes** | tem proposta, mas com aviso ou confiança menor | 👀 caso a caso |
| **Já padronizados** | já estão exatamente como o plano propõe | nada a fazer |
| **Sem regra possível** | não há chave utilizável | leia o motivo |

**Cada linha mostra:**

```
Nome do conjunto
elleven · public.contratos · 1.482.330 linhas
último sucesso: 20/09/2026, 03:14:02
hoje: snapshot (recarrega tudo)  →  created_at + updated_at · identidade id · de minuto em minuto
                                     ↑ o que a proposta muda
```

À direita, a pílula de estado (`Confiança alta`, `Confere antes`,
`Precisa de revisão`, `Já padronizado`, `Sem regra possível`, `Falhando`) e a
contagem de avisos.

**Clique na linha para expandir.** Aparecem dois blocos, e os dois importam:

- **Por que esta regra** — qual coluna foi escolhida para cada papel e de onde
  veio a identidade (chave primária? índice único? palpite pelo nome?).
- **O que conferir antes** — os riscos. É aqui que mora a decisão.

### 3.2 Conjuntos › *(um conjunto)* › Sincronização com o lake

A configuração individual. Os campos:

| Campo | O que é |
|---|---|
| **Modo** | `Ao vivo` (sem lake), `Snapshot` (recarrega tudo), `Incremental` |
| **Chave incremental** | a coluna crescente da 1ª passada — a data de criação |
| **Publicar a partir de** | piso da 1ª carga: data fixa ou "últimos N dias" |
| **Identidade da linha** | o que identifica a linha (abre um diálogo de seleção) |
| **2ª chave** | a data de edição — **só habilita depois da identidade** |
| **Folga de reconferência** | quanto o corte **volta no tempo** a cada execução. **Não é frequência** — quem define a frequência é a cadência |
| **Cadência** | de quanto em quanto tempo sincroniza sozinho |

Abaixo, **Sincronizar agora**, **Parar** e o histórico de execuções.

> **Salvar** só habilita quando há algo diferente do que está gravado, e vira
> *"Configuração salva"* em verde ao concluir. Botão apagado significa que não
> há nada pendente — não que a gravação falhou.

> Quando o conjunto segue um agendamento, o lugar da cadência mostra **qual
> agendamento, com que intervalo e em que janela**. Mudar a frequência é lá, em
> Administração › Agendamentos, porque ela vale para todos os conjuntos que
> seguem aquele agendamento.

> **A 2ª chave fica desabilitada até existir identidade.** Não é capricho da
> tela: o banco recusa a combinação, porque sem identidade as duas passadas
> duplicariam a linha com certeza.

**Folga de reconferência (não confundir com frequência):** relê os últimos N
minutos a cada execução — não muda de quanto em quanto tempo ela roda. Serve
para edição que chega com carimbo atrasado (transação longa, relógio da fonte
fora de hora) e ficaria atrás do corte. A repetição é absorvida pela
identidade. O diagnóstico propõe **10 minutos** quando há identidade e chave de
data; sem identidade, propõe **0** — com folga e sem identidade, você
garantiria duplicatas.

### 3.3 Administração › Agendamentos

Um agendamento é uma política **nomeada e reutilizável**: janela de horário +
dias da semana + intervalo em minutos. É o que viabiliza a cadência de minutos.

Editar um agendamento **propaga para todos** os conjuntos que o usam. Apagar
devolve todos para a cadência diária.

### 3.4 Usuários e Acessos › Admin master

Só aparece para quem já é master. Lista as duas origens:

- **Ambiente do servidor** — fixo na stack, não removível pela tela. É o caminho
  de recuperação.
- **Concedido na tela** — delegação, removível ali mesmo.

---

## 4. Roteiro A — padronizar um conjunto

1. **Administração › Padronizar atualização** e aguarde a análise.
2. Filtro **Prontos para aplicar**. Clique numa linha e leia **Por que esta
   regra**. Confira três coisas:
   - a **chave incremental** é mesmo a data de criação daquela tabela?
   - a **2ª chave** é mesmo a data de edição?
   - a **identidade** veio de *chave primária* ou *índice único*? Se disser
     **"palpite pelo nome da coluna"**, não aplique sem confirmar que aquela
     coluna realmente não repete.
3. Escolha o **agendamento** na barra superior (ver Roteiro C). Sem agendamento,
   os conjuntos que caberiam em minutos ficam de hora em hora.
4. Marque os conjuntos — ou use **Marcar os N prontos**.
5. **Aplicar**. Leia a confirmação: ela diz quantos passam para cadência de
   minutos, **quantos deixam o agendamento que seguem hoje** e **quantos vão
   recarregar a tabela inteira uma vez**.
   > Pedir cadência fixa (diária/hora em hora) a um conjunto que hoje segue um
   > agendamento nomeado **tira ele desse agendamento**. É o comportamento
   > correto — cadência fixa e agendamento são excludentes —, mas é uma
   > mudança que ninguém adivinha; por isso a confirmação conta.
6. **Leia o painel de resultado** que aparece no topo: `N de M conjunto(s)
   aplicado(s)`. Se algum falhar, o painel lista o motivo agrupado e os nomes
   dos conjuntos afetados — ele **não some** com a reanálise, então dá para ler
   com calma.
7. Vá ao conjunto e **Sincronizar agora**, ou espere o agendamento.

> **Aplicar muda só a configuração.** O efeito no lake aparece na próxima
> sincronização.

### Quando NÃO aplicar a proposta

| Situação | Por quê |
|---|---|
| Identidade veio de "palpite pelo nome" | pode não ser única; duplicaria ou colapsaria linhas distintas |
| O aviso diz que a chave não tem índice, e o conjunto é grande | peça o índice antes |
| O conjunto está **Falhando** | resolva a falha primeiro (Roteiro B) |
| Tabela grande e você está em horário de pico | a 1ª carga lê a tabela inteira |

---

## 5. Roteiro B — destravar um conjunto parado

**Sintoma:** o conjunto aparece em **Não estão atualizando**, ou o histórico
mostra erro em toda execução.

**Caso real, para reconhecer o padrão:** um conjunto vinha falhando havia dias
com `column "regular_price" does not exist`. Um campo publicado apontava para
uma coluna que não existe mais na origem — alguém a renomeou ou removeu. O
`SELECT` da ingestão incluía essa coluna, o banco recusava a consulta inteira, e
o conjunto ficou congelado. Nada disso aparecia na lista de conjuntos: ele
parecia saudável.

**O que fazer:**

1. Abra a linha no filtro **Não estão atualizando**.
2. Se aparecer o bloco vermelho **"Campos apontando para colunas que não existem
   mais"**, com a lista das colunas:
   - **confirme com quem mexeu na origem** se a coluna foi removida ou apenas
     renomeada;
   - **confira se algum painel, métrica ou conjunto calculado usa esses
     campos** — eles vão parar de receber dado;
   - clique em **Remover esses campos e destravar**.
3. Se o campo removido era a chave incremental ou parte da identidade, a
   configuração é zerada junto e a próxima carga recomeça do zero. A tela avisa.
4. Rode **Sincronizar agora** e confirme que o run terminou com `concluído`.
5. Volte à tela de padronização e **reanalise**: agora o conjunto deve aparecer
   com proposta.

**Se o erro for outro** (timeout, permissão, conexão), o bloco vermelho não
aparece — a causa está fora do hub. O diagnóstico ainda mostra o último erro e
há quantas execuções ele se repete.

---

## 6. Roteiro C — cadência de minutos

1. **Administração › Agendamentos**. Se ainda não houver um, crie a partir de
   *Conjuntos*, selecionando os conjuntos e usando **Agendar atualização**.
2. Defina janela e intervalo. Sugestão inicial: **07:00–19:00, seg–sex, a cada
   10 minutos**. Comece conservador.

> ⚠️ **Dias da semana valem para TUDO que segue o agendamento.** Um agendamento
> marcado só de seg–sex não sincroniza nada no sábado e no domingo — na segunda
> de manhã o dado tem mais de dois dias. Foi o que produziu um "frescor mediano
> de 47 h" observado num domingo. Se o conjunto precisa estar fresco todo dia,
> marque os sete dias, ainda que com intervalo maior no fim de semana (para
> isso, use dois agendamentos).
3. Na tela de padronização, escolha esse agendamento no seletor **Cadência de
   minutos** antes de aplicar.

**Por que começar em 10 e não em 1 minuto:**

- as sincronizações rodam **uma de cada vez** no hub inteiro (fila sequencial).
  Se a soma das execuções passar do intervalo, a fila só acumula atraso;
- fora da janela, nada roda — é isso que deixa a madrugada livre para as cargas
  pesadas;
- dá para apertar depois, olhando o tempo real de cada execução no histórico.

**Como saber se o intervalo cabe:** some a duração das execuções dos conjuntos
naquele agendamento (histórico de cada conjunto). Se a soma se aproximar do
intervalo, aumente o intervalo ou divida em dois agendamentos.

---

## 6b. Recarga completa (consertar histórico)

Uma execução normal **não reescreve o passado**: o incremental só traz o que
passou do corte. Quando o que já está gravado no lake está errado — foi o caso
do defeito de fuso de 28/09/2026 —, a única saída é reler a fonte inteira.

O caminho é **Padronizar atualização › filtro "Precisam de recarga"**. Ali a
barra de ações muda: marque os conjuntos (há atalhos para *todos os que
precisam* e para *os 5 menores*) e use **"Recarregar selecionados"** — a
estimativa de fila aparece ao lado da contagem, antes do clique. Para um só,
abra o conjunto e use **"Recarregar tudo"**.

Em qualquer dos dois, o corte é zerado e a fonte é lida uma vez inteira; o modo
não muda e o conjunto volta a ser incremental logo depois.

> ⚠️ **Não use o piso ("Publicar a partir de") para forçar recarga.** Ele zera o
> corte, sim — mas a carga seguinte SUBSTITUI as partes antigas, então o
> conjunto fica só com o período do piso e **o histórico anterior é perdido**.

**O que a tela já responde antes de você clicar:** quantos conjuntos precisam,
quanto ocupam no lake e a fila estimada. Quem **não** precisa também aparece
explicado — conjunto em snapshot se refaz sozinho a cada execução, e fonte
MySQL nunca foi afetada.

**Onde acompanhar:** o card **Fila de sincronização**, no topo da própria tela
de *Padronizar atualização*. Só **uma** sincronização roda por vez no hub
inteiro — se aparecerem várias em "rodando", ou uma com duração em dias, são
execuções presas de um processo que morreu no meio; elas se fecham sozinhas no
próximo boot da API. Ele mostra o que está rodando agora (com linhas e
tempo decorrido), quem está na espera e por qual ordem, e as últimas que
terminaram. Atualiza sozinho e **some quando não há nada na fila** — então, se
ele não aparece, é porque acabou.

**Como conduzir sem apertar a plataforma:**

- as sincronizações rodam **uma de cada vez** no hub inteiro, então a recarga
  não concorre com as outras — mas **ocupa a fila** enquanto durar, e os
  agendamentos de minutos ficam esperando;
- faça **do menor para o maior** (a lista já vem nessa ordem): correção cedo, e
  os caros ficam para uma janela escolhida;
- o pico é de **disco**: durante a carga convivem o Parquet atual, o arquivo
  temporário e o Parquet novo. Um conjunto grande de cada vez, e olho no espaço
  livre;
- conjuntos realmente grandes: **fora do horário comercial**, um por noite.

## 7. Checklist de validação

### Por conjunto, logo após aplicar

- [ ] **Modo** é `Incremental` e a **chave incremental** é a data de criação.
- [ ] Se a tabela tem data de edição, a **2ª chave** está preenchida.
- [ ] **Identidade da linha** preenchida, e vinda de chave primária/índice único.
- [ ] O painel não mostra aviso que você não tenha lido.
- [ ] Uma execução manual (**Sincronizar agora**) termina com `concluído`.

### No dia seguinte

- [ ] O conjunto **não** aparece em *Não estão atualizando*.
- [ ] Último sucesso é recente e compatível com a cadência.
- [ ] No histórico, a coluna **Compactação** mostra `dispensada` na maioria das
      execuções. Se compacta sempre e demora, reveja a cadência.
- [ ] A coluna de **arquivos** não cresce sem parar (o teto é 24 por padrão).
- [ ] O **total de linhas** parou de crescer sozinho. Se caiu na primeira
      execução após definir identidade, **isso é o esperado**.

### Validação de conteúdo (a que realmente prova)

Escolha uma linha que você sabe que foi **editada hoje** na origem e confira, no
Explorador, se o valor no lake bate com o da fonte. Esse é o teste que nenhuma
métrica substitui: prova que a 2ª chave e a identidade estão funcionando juntas.

> Um segundo teste útil: conte no lake as ocorrências da identidade de uma linha
> muito editada. Tem que ser **1**.

---

## 8. Erros e o que significam

| Mensagem | Causa | O que fazer |
|---|---|---|
| `column "x" does not exist` | campo publicado aponta para coluna removida/renomeada na origem | Roteiro B |
| `Sincronização incremental não convergiu: a chave "x" não avançou` | a chave escolhida não é crescente/única o bastante | trocar por outra (ex.: `id`) |
| horário no lake 3 h adiantado em relação à fonte | conversão de fuso | corrigido em 28/09/2026; se reaparecer, abrir chamado |
| conjunto para de trazer linhas novas, sem erro | watermark no futuro (fuso) | idem — conferir o horário do último registro no lake |
| `maximum_object_size ... exceeded while reading file ... .jsonl` | linha da tabela maior que o teto do DuckDB **ou** arquivo de staging cortado no meio | teto subiu para 64 MB em 29/09/2026; se persistir, a mensagem agora diz quando é arquivo truncado (falta de espaço em disco) |
| `Interrompida: o servidor reiniciou durante a execução` | a execução foi cortada por um deploy/restart; a linha ficava presa em "rodando" | nada a fazer — é fechada sozinha no boot seguinte, e o conjunto volta a sincronizar normalmente |
| `Arquivo de staging incompleto: N bytes sem a quebra de linha final` | a escrita foi interrompida — quase sempre disco cheio no volume do lake | liberar espaço e sincronizar de novo; o conteúdo antigo continua intacto |
| `Binder Error: Cannot combine types of … - an explicit cast is required` | defeito do servidor na compactação (chave numérica comparada com data) | corrigido em 21/09/2026; se reaparecer, avisar quem mantém o Data Hub |
| `Sincronização abortada: excedeu N linhas` | disjuntor `SYNC_MAX_ROWS` — provável carga em fuga | usar incremental e/ou definir piso |
| `Para usar duas chaves é preciso definir a identidade da linha` | 2ª chave sem identidade | definir a identidade primeiro |
| `Somente o administrador master pode alterar…` | ação restrita a master | ver seção 9 |
| `Falha ao trocar a cadência de um conjunto que segue um agendamento nomeado` | defeito do servidor | avisar quem mantém o Data Hub — não é a sua seleção |
| `Nenhuma coluna serve de chave incremental` | tabela sem data de criação e sem coluna comprovadamente única | manter em snapshot, ou publicar a coluna de data se ela existir |
| `Nenhum administrador master está configurado neste servidor` | configuração do servidor, não permissão | avisar quem cuida da stack |
| Conjunto some do lake / total zerado | recarga em andamento após troca de modo | aguardar a 1ª carga terminar |

---

## 9. Quem pode o quê

Mudar **como uma FONTE atualiza** mexe na carga sobre os bancos de produção e na
integridade do lake. Por isso é do **administrador master**.

| Ação | Quem |
|---|---|
| Ver o diagnóstico da padronização | Administrador |
| **Aplicar** a padronização | **Master** |
| Alterar a regra de um conjunto de **fonte** | **Master** |
| Criar/editar/apagar **agendamento** que rege fonte | **Master** |
| Aplicar ou retirar agendamento de uma fonte | **Master** |
| Reconciliar campos com a fonte | **Master** |
| **Sincronizar agora** / **Parar** | Administrador |
| Ver histórico de execuções | Administrador |
| Tudo em conjuntos **calculados** | Administrador / Editor |

**Por que master e não admin:** qualquer administrador pode conceder o papel
*Administrador* a quem quiser — inclusive a si mesmo — pela tela de acessos.
Então *Administrador* nunca foi uma fronteira entre administradores. O acesso
master vem do **ambiente do servidor** ou de uma **concessão feita por outro
master**, e por isso não é auto-concedível.

**Conjuntos calculados seguem liberados** para administradores e editores: eles
rodam SQL sobre o lake e não encostam em fonte nenhuma.

---

## 10. Como sugiro conduzir

Não aplique tudo de uma vez. A ordem abaixo entrega valor cedo e mantém o risco
pequeno:

**Etapa 1 — limpar o que está quebrado (antes de qualquer padronização).**
Filtro *Não estão atualizando*. Um conjunto parado é mais urgente que um
conjunto com regra subótima, e não adianta discutir cadência de quem não roda.

**Etapa 2 — três conjuntos piloto.** Escolha três de *Prontos para aplicar*:
um pequeno, um médio e um grande. Aplique **sem** agendamento (ficam de hora em
hora), rode manual e acompanhe por um dia inteiro usando o checklist da seção 7.
O objetivo é calibrar a confiança na proposta, não ganhar tempo.

**Etapa 3 — o lote.** Com os pilotos validados, aplique o restante de *Prontos
para aplicar* com um agendamento de 10 minutos. Volte no dia seguinte e confira
o painel inteiro.

**Etapa 4 — os difíceis.** Só então o filtro *Conferir antes*, um a um. Aqui as
decisões são de negócio: pedir índice, publicar coluna que falta, aceitar que
uma tabela sem data de edição não recupera edições.

**Etapa 5 — apertar.** Com tudo estável, avalie reduzir o intervalo dos
agendamentos, olhando o tempo real das execuções.

**Combinado sugerido:** a Etapa 2 é feita junto, com o master presente, para que
as dúvidas apareçam antes de virarem lote. Da Etapa 3 em diante, a pessoa
treinada conduz e o master só aprova o clique de aplicar.

---

## 11. Glossário

| Termo | Significado |
|---|---|
| **Lake** | a cópia em Parquet dos dados. Toda consulta de usuário lê daqui |
| **Conjunto de fonte** | conjunto que ingere de um banco de origem |
| **Conjunto calculado** | conjunto feito por SQL sobre o lake; não toca fonte |
| **Watermark** | maior valor da chave já lido; ponto de partida da próxima execução |
| **Keyset** | ler por `WHERE chave > X ORDER BY chave LIMIT n`, em vez de `OFFSET` |
| **Identidade da linha** | campo(s) que dizem "esta linha é a mesma"; habilita substituir em vez de acrescentar |
| **Compactação** | reescrever o conjunto mantendo só a versão mais recente de cada identidade |
| **Cadência** | de quanto em quanto tempo o conjunto sincroniza sozinho |
| **Agendamento** | política nomeada (janela + dias + intervalo) aplicável a vários conjuntos |
| **Folga de reconferência** | minutos que o watermark rebobina, para pegar carimbo atrasado |
| **Piso / cutoff** | a partir de que ponto a primeira carga começa |

---

## Dúvidas

Traga a dúvida com **o nome do conjunto** e **um print do painel expandido** (os
blocos *Por que esta regra* e *O que conferir antes*). Com esses dois, a
resposta costuma sair na hora; sem eles, vira adivinhação.
