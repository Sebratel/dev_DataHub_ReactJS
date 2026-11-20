// ─────────────────────────────────────────────────────────────────────────
// Notebooks prontos da onda 1 (item 6 de 19/11/2026): SQL agrega no motor,
// Python modela no navegador (Pyodide: pandas, numpy, scipy, statsmodels,
// matplotlib). Cada célula SQL entrega no máximo 500 linhas ao Python, então
// o SQL sempre devolve dado já agregado.
//
// Regras para quem mexer aqui:
//   • A célula Python recebe a célula SQL logo acima como `df`. Para usar
//     duas consultas, guarde a primeira numa variável antes da segunda SQL.
//   • Contagem (BIGINT) e decimal chegam como TEXTO no JSON; a função
//     `tabela()` do primeiro bloco Python converte. Datas chegam como texto.
//   • As versões do Pyodide 0.26 são antigas (pandas 2.2, matplotlib 3.5,
//     statsmodels 0.14): nada de API nova.
//   • O código Python fica em String.raw — "\n" num print viraria quebra de
//     linha real dentro da string e o Python recusaria.
//   • O SQL passa pela guarda do lake: nada de palavras como insert, update,
//     into, set, use, comment, nem em comentário.
// Validados com dado real do Voalle em 20/11/2026 (ver docs/RUNBOOK.md).
// ─────────────────────────────────────────────────────────────────────────
import type { PackNotebook } from '../packs.js'

const py = String.raw

// Primeiro bloco Python de todo notebook.
const PRELUDIO = py`import warnings
warnings.filterwarnings("ignore")
import re
import numpy as np
import pandas as pd
pd.set_option("display.width", 160)
pd.set_option("display.max_columns", 30)

# Colunas de data pelo nome exato: "mes_vencimento" e "vence_em" sim, "meses_de_casa" não.
_DATA = re.compile(r"(mes(_[a-z]+)*|safra|data(_[a-z]+)*|[a-z_]+_em)")

def tabela(d):
    """Resultado do SQL pronto para conta: texto numérico vira número; mês/data vira data."""
    d = d.copy()
    for c in d.columns:
        if _DATA.fullmatch(c):
            d[c] = pd.to_datetime(d[c], errors="coerce")
        elif d[c].dtype == object:
            n = pd.to_numeric(d[c], errors="coerce")
            if d[c].notna().any() and n.notna().sum() == d[c].notna().sum():
                d[c] = n
    return d

def num(v, casas=0):
    """Número no formato brasileiro: 12.345,6"""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "—"
    s = f"{v:,.{casas}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")

def brl(v):
    return "R$ " + num(v, 0)
`

const AVISO_ORDEM = 'Rode com **Executar tudo** (de cima para baixo): cada bloco Python usa o resultado da consulta logo acima e o que os blocos anteriores guardaram.'

export const NOTEBOOKS_ONDA_1: PackNotebook[] = [
  // ── 1. Cancelamento: tendência, sazonalidade e previsão ─────────────────
  {
    slug: 'analise_cancelamento_tendencia_previsao', domain: 'cancelamento',
    name: 'Cancelamento: tendência, sazonalidade e previsão',
    description: 'A taxa oficial de cancelamento mês a mês: se está subindo de verdade ou é ruído, quais meses fugiram do padrão, em que época do ano se cancela mais e quanto esperar nos próximos 6 meses.',
    cells: [
      { kind: 'markdown', source: `# Cancelamento: tendência, sazonalidade e previsão

**Pergunta:** a taxa de cancelamento está piorando? O que esperar nos próximos meses?

**Fonte:** \`ouro_cancelamento_mensal\` (taxa oficial: cancelamentos de contratos instalados no mês ÷ base ativa no fim do mês anterior; venda em lote e contrato duplicado não contam) e \`ouro_base_ativa_mensal\`. Só meses fechados.

**Métodos:**
- Uma reta robusta acha os meses atípicos (ex.: uma limpeza de base), que são trocados pela mediana dos vizinhos.
- Sobre a série limpa: regressão linear para a tendência, com teste de significância.
- Para a previsão: três métodos (suavização exponencial com e sem sazonalidade, e a média recente) tentam prever os 6 meses que já conhecemos. Fica o que errar menos.

${AVISO_ORDEM}` },
      { kind: 'sql', source: `select c.mes,
  cast(c.base_inicio as double) as base_inicio,
  cast(b.contratos_ativos as double) as base_fim,
  cast(c.cancelamentos as double) as cancelamentos,
  c.taxa_cancelamento_pct,
  cast(c.cancelamentos_em_lote as double) as cancelamentos_em_lote
from ouro_cancelamento_mensal c
join ouro_base_ativa_mensal b on b.mes = c.mes
where c.mes < date_trunc('month', current_date) and c.base_inicio > 0
order by c.mes` },
      { kind: 'python', source: py`${PRELUDIO}
serie = tabela(df).sort_values("mes").set_index("mes")
taxa = serie["taxa_cancelamento_pct"].astype(float)
print(f"{len(taxa)} meses fechados, de {taxa.index.min():%m/%Y} a {taxa.index.max():%m/%Y}.")
ult = taxa.tail(12)
print(f"Últimos 12 meses: média {num(ult.mean(), 2)}% ao mês (mínimo {num(ult.min(), 2)}%, máximo {num(ult.max(), 2)}%).")
if len(taxa) >= 24:
    ant = taxa.iloc[-24:-12]
    print(f"12 meses anteriores: média {num(ant.mean(), 2)}% ao mês -> variação de {num(ult.mean() - ant.mean(), 2)} p.p.")
print(f"Cancelamentos nos últimos 12 meses: {num(serie['cancelamentos'].tail(12).sum())} "
      f"(+ {num(serie['cancelamentos_em_lote'].tail(12).sum())} em venda de lote, fora da taxa).")
` },
      { kind: 'python', source: py`import statsmodels.api as sm
t = np.arange(len(taxa))
X = sm.add_constant(t)

# 1) Meses atípicos: desvio de uma reta ROBUSTA (um mês extremo não entorta a reta).
robusta = sm.RLM(taxa.values, X, M=sm.robust.norms.HuberT()).fit()
desvio = taxa.values - robusta.predict(X)
mad = np.median(np.abs(desvio - np.median(desvio))) * 1.4826
z = (desvio - np.median(desvio)) / mad if mad > 0 else desvio * 0
atipico = np.abs(z) > 3
if atipico.any():
    print("Meses fora do padrão (desvio robusto acima de 3) — trocados pela mediana dos vizinhos no resto da análise:")
    print(serie.assign(desvio_robusto=np.round(z, 1))[atipico][["cancelamentos", "taxa_cancelamento_pct", "desvio_robusto"]].to_string())
else:
    print("Nenhum mês fora do padrão.")
limpa = taxa.copy()
limpa[atipico] = taxa.rolling(5, center=True, min_periods=1).median()[atipico]

# 2) Tendência sobre a série limpa, com teste de significância.
reta = sm.OLS(limpa.values, X).fit()
por_ano = reta.params[1] * 12
p = reta.pvalues[1]
veredito = "é estatisticamente significativa" if p < 0.05 else "NÃO é significativa: a variação cabe no ruído do mês a mês"
print(f"\nTendência: {num(por_ano, 2)} p.p. por ano (p = {p:.3f}) -> {veredito}.")
residuo = limpa.values - reta.predict(X)

if len(taxa) >= 24:
    efeito = pd.Series(residuo, index=taxa.index).groupby(taxa.index.month).mean()
    nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
    efeito.index = [nomes[m - 1] for m in efeito.index]
    print("\nEfeito médio de cada mês do ano (p.p. acima ou abaixo da tendência):")
    print(efeito.round(2).sort_values(ascending=False).to_string())
` },
      { kind: 'python', source: py`from statsmodels.tsa.exponential_smoothing.ets import ETSModel
import matplotlib.pyplot as plt

y = limpa.copy()
y.index = pd.DatetimeIndex(y.index).to_period("M")

def ets(s, sazonal):
    return ETSModel(s, error="add", trend="add", damped_trend=True, seasonal="add" if sazonal else None,
                    seasonal_periods=12 if sazonal else None).fit(disp=False)

# Qual método acerta mais AQUI? Cada um prevê os últimos 6 meses já conhecidos
# usando só o que veio antes; fica o de menor erro médio.
metodos = {"ETS sem sazonalidade": lambda s: ets(s, False), "média dos últimos 6 meses": None}
if len(y) >= 30:
    metodos = {"ETS com sazonalidade": lambda s: ets(s, True), **metodos}
erro = {}
for nome, ajusta in metodos.items():
    treino, teste = y.iloc[:-6], y.iloc[-6:]
    p_teste = np.repeat(treino.tail(6).mean(), 6) if ajusta is None else ajusta(treino).forecast(6).values
    erro[nome] = float(np.mean(np.abs(p_teste - teste.values)))
melhor = min(erro, key=erro.get)
print("Erro médio de cada método prevendo os 6 últimos meses (p.p.):")
for nome, e in sorted(erro.items(), key=lambda x: x[1]):
    print(f"  {nome:28s} {num(e, 3)}" + ("  <- usado" if nome == melhor else ""))

futuro = pd.period_range(y.index[-1] + 1, periods=6, freq="M")
if metodos[melhor] is None:
    m, dp = y.tail(6).mean(), y.tail(12).std()
    prev = pd.DataFrame({"mean": m, "pi_lower": m - 1.28 * dp, "pi_upper": m + 1.28 * dp}, index=futuro)
else:
    prev = metodos[melhor](y).get_prediction(start=len(y), end=len(y) + 5).summary_frame(alpha=0.2)
base = float(serie["base_fim"].iloc[-1])
prev["cancelamentos_esperados"] = (prev["mean"] / 100 * base).round(0)
saida = pd.DataFrame({
    "taxa_prevista_pct": prev["mean"].round(2),
    "faixa_80pct": [f"{num(a, 2)} a {num(b, 2)}" for a, b in zip(prev["pi_lower"], prev["pi_upper"])],
    "cancelamentos_esperados": prev["cancelamentos_esperados"].astype(int),
})
saida.index = saida.index.strftime("%m/%Y")
print(f"\nPrevisão para os próximos 6 meses — {melhor} (base de hoje: {num(base)} contratos):")
print(saida.to_string())

fig, ax = plt.subplots(figsize=(9, 3.6))
ax.plot(pd.DatetimeIndex(taxa.index), taxa.values, marker="o", ms=3, label="taxa realizada")
if atipico.any():
    ax.scatter(pd.DatetimeIndex(taxa.index)[atipico], taxa.values[atipico], s=40, facecolors="none",
               edgecolors="#E07B00", label="mês atípico")
fx = prev.index.to_timestamp()
ax.plot(fx, prev["mean"], color="#880F17", marker="o", ms=3, label="previsão")
ax.fill_between(fx, prev["pi_lower"], prev["pi_upper"], color="#880F17", alpha=0.15, label="faixa de 80%")
ax.set_ylabel("% ao mês")
ax.set_title("Taxa de cancelamento: realizado e previsão")
ax.grid(alpha=0.3)
ax.legend(loc="upper left", fontsize=8)
plt.show()
` },
      { kind: 'markdown', source: `## Como ler

- **Tendência significativa** quer dizer que a inclinação é maior do que o sobe e desce normal. Se não for, não trate um mês ruim como piora.
- **Mês fora do padrão** costuma ter causa operacional: limpeza de base, mudança de régua de cobrança, campanha ou evento de rede. Vale cruzar com o motivo em \`ouro_cancelamento_mensal_por_motivo\`. Ele fica fora da tendência e da previsão para não contaminá-las.
- **Previsão:** a faixa de 80% é onde a taxa deve cair em 4 de cada 5 meses. Ela supõe que nada muda (preço, régua, concorrência). O erro médio do teste diz quanto confiar: com a base de hoje, um erro de 0,2 p.p. dá cerca de 180 cancelamentos por mês.` },
    ],
  },

  // ── 2. Retenção por safra, vida média e receita esperada ─────────────────
  {
    slug: 'analise_cancelamento_sobrevivencia_ltv', domain: 'cancelamento',
    name: 'Retenção por safra, vida média e receita esperada por contrato',
    description: 'Curva de sobrevivência dos contratos (Kaplan-Meier) por ano de instalação: quanto fica depois de 3, 6, 12 e 24 meses, se as safras novas retêm melhor que as antigas, vida média do contrato e receita esperada por contrato novo.',
    cells: [
      { kind: 'markdown', source: `# Retenção por safra, vida média e receita esperada

**Pergunta:** quanto tempo um contrato fica com a gente? As safras recentes seguram melhor que as antigas? Quanto vale, em receita, um contrato novo?

**Fonte:** \`ouro_cancelamento_retencao_por_safra\` (contratos ativos de cada mês de instalação, mês a mês, até 24 meses; venda em lote não conta como saída) e \`ouro_base_ativa_mensal\` (ticket médio).

**Método:** a saída de cada mês de vida é calculada só com as safras que já chegaram àquele mês, e as saídas viram uma curva de sobrevivência (Kaplan-Meier). Depois dos 24 meses, a curva segue a taxa média de saída dos últimos 6 meses observados.

${AVISO_ORDEM}` },
      { kind: 'sql', source: `with r as (
    select safra, meses_de_casa, cast(contratos_na_safra as double) as contratos, cast(ativos as double) as ativos
      from ouro_cancelamento_retencao_por_safra
  )
select cast(extract(year from a.safra) as integer) as ano_safra, a.meses_de_casa,
  sum(b.ativos) as em_risco, sum(b.ativos - a.ativos) as sairam
from r a join r b on b.safra = a.safra and b.meses_de_casa = a.meses_de_casa - 1
group by 1, 2
union all
select cast(extract(year from safra) as integer), 0, sum(contratos), sum(contratos - ativos)
from r where meses_de_casa = 0
group by 1
order by 1, 2` },
      { kind: 'python', source: py`${PRELUDIO}
import matplotlib.pyplot as plt
h = tabela(df)

def sobrevivencia(g):
    g = g.groupby("meses_de_casa")[["em_risco", "sairam"]].sum().sort_index()
    saida = (g["sairam"] / g["em_risco"]).clip(0, 1)
    return (1 - saida).cumprod()

curvas = {str(int(a)): sobrevivencia(g) for a, g in h.groupby("ano_safra")}
curvas["todas as safras"] = sobrevivencia(h)
tab = pd.DataFrame(curvas)
marcos = [m for m in [0, 3, 6, 12, 18, 24] if m in tab.index]
print("Contratos que seguem ativos (%) depois de N meses da instalação:")
print((tab.loc[marcos] * 100).round(1).to_string())

fig, ax = plt.subplots(figsize=(8, 3.6))
for nome, s in curvas.items():
    estilo = dict(color="#880F17", lw=2.5) if nome == "todas as safras" else dict(lw=1.2, alpha=0.8)
    ax.plot(s.index, s.values * 100, label=nome, **estilo)
ax.set_xlabel("meses desde a instalação")
ax.set_ylabel("% ainda ativos")
ax.set_title("Sobrevivência dos contratos por ano de instalação")
ax.grid(alpha=0.3)
ax.legend(fontsize=8)
plt.show()
` },
      { kind: 'python', source: py`# Onde a curva cai mais: saída mensal média em cada fase da vida do contrato.
geral = h.groupby("meses_de_casa")[["em_risco", "sairam"]].sum()
fases = [("1º mês (inclui o mês da instalação)", 0, 1), ("meses 2 a 3", 2, 3), ("meses 4 a 6", 4, 6),
         ("meses 7 a 12", 7, 12), ("meses 13 a 24", 13, 24)]
print("Saída média por mês em cada fase (todas as safras):")
for rotulo, a, b in fases:
    f = geral.loc[(geral.index >= a) & (geral.index <= b)]
    if len(f):
        print(f"  {rotulo:38s} {num(100 * f['sairam'].sum() / f['em_risco'].sum(), 2)}% ao mês")
` },
      { kind: 'sql', source: `select mes, arpu, cast(contratos_ativos as double) as contratos_ativos
from ouro_base_ativa_mensal
where mes < date_trunc('month', current_date)
order by mes desc
limit 1` },
      { kind: 'python', source: py`arpu = float(tabela(df)["arpu"].iloc[0])
s = curvas["todas as safras"].dropna()
k = int(s.index.max())
# Cauda: a saída média mensal dos últimos 6 meses observados continua para sempre.
q = 1 - (s.iloc[-1] / s.iloc[-7]) ** (1 / 6) if len(s) > 7 else 0.02
vida_observada = float(s.sum())
vida_cauda = float(s.iloc[-1] * (1 - q) / q) if q > 0 else float("nan")
vida = vida_observada + vida_cauda
abaixo = s[s <= 0.5]
mediana = int(abaixo.index[0]) if len(abaixo) else k + np.log(0.5 / s.iloc[-1]) / np.log(1 - q)
print(f"Saída mensal depois de {k} meses de casa (usada na cauda): {num(100 * q, 2)}% ao mês")
print(f"Vida média esperada de um contrato novo: {num(vida, 1)} meses ({num(vida / 12, 1)} anos)")
print(f"Metade dos contratos sai até o mês {num(mediana, 0)} de vida")
print(f"Ticket médio (ARPU) do último mês fechado: R$ {num(arpu, 2)}")
print(f"Receita esperada por contrato novo: {brl(arpu * vida)} (receita bruta, sem custo de instalação e sem margem)")
` },
      { kind: 'markdown', source: `## Como ler

- Compare as curvas por ano no **mesmo mês de vida**. Se a safra mais nova está acima da antiga aos 6 meses, a entrada (venda e instalação) melhorou.
- Saída alta no 1º mês costuma ser problema de instalação ou de venda (expectativa errada), não de serviço.
- A **receita esperada** serve para comparar com o custo de aquisição (comissão, instalação, equipamento): uma venda que custa mais do que isso não se paga.
- A cauda depois de 24 meses é uma suposição. Quanto mais safras completarem 2 anos, menos o número depende dela.` },
    ],
  },

  // ── 3. Risco de cancelamento por perfil (modelo logístico) ──────────────
  {
    slug: 'analise_cancelamento_risco_por_perfil', domain: 'cancelamento',
    name: 'Risco de cancelamento por perfil (modelo logístico)',
    description: 'Quem cancela mais quando se olha tudo junto: tempo de casa, faixa de valor, PF/PJ e cidade num modelo logístico sobre os últimos 12 meses. Mostra o efeito de cada fator isolado e os segmentos que concentram as perdas esperadas.',
    cells: [
      { kind: 'markdown', source: `# Risco de cancelamento por perfil

**Pergunta:** o que, de fato, aumenta a chance de um contrato cancelar? Onde concentrar a retenção?

**Fonte:** \`prata_voalle_contratos\`. Entram os contratos instalados e ativos no início da janela (os últimos 12 meses fechados). O desfecho é cancelar dentro da janela; venda em lote e contrato duplicado não contam.

**Método:** regressão logística sobre os contratos agrupados por segmento (o SQL agrupa, o Python ajusta o modelo). A **razão de chances** de cada fator compara com a categoria mais comum, com os outros fatores fixos. Exemplo: 1,8 = 80% mais chance de cancelar.

${AVISO_ORDEM}` },
      { kind: 'sql', source: `with p as (
    select cast(date_trunc('month', current_date) - interval 12 month as date) as ini,
           cast(date_trunc('month', current_date) - interval 1 day as date) as fim
  ), expostos as (
    select c.cidade, c.pessoa, c.valor_mensal, c.cancelado_em, c.motivo_codigo,
           date_diff('day', c.instalado_em, p.ini) as dias_no_inicio, p.fim
      from prata_voalle_contratos c, p
     where c.instalado and c.instalado_em < p.ini
       and (c.cancelado_em is null or c.cancelado_em >= p.ini)
       and not (c.cancelado_em_lote and c.cancelado_em <= p.fim)
  ), maiores as (
    select cidade from expostos where cidade is not null group by 1 order by count(*) desc limit 6
  )
select
  case when dias_no_inicio < 180 then '1 · até 6 meses'
       when dias_no_inicio < 365 then '2 · 6 a 12 meses'
       when dias_no_inicio < 730 then '3 · 1 a 2 anos'
       when dias_no_inicio < 1095 then '4 · 2 a 3 anos'
       else '5 · 3 anos ou mais' end as tempo_de_casa,
  case when valor_mensal <= 0 then '0 · não faturado'
       when valor_mensal < 100 then '1 · até R$ 99'
       when valor_mensal < 150 then '2 · R$ 100 a 149'
       when valor_mensal < 200 then '3 · R$ 150 a 199'
       else '4 · R$ 200 ou mais' end as faixa_valor,
  case when pessoa = 'PJ' then 'PJ' else 'PF' end as pessoa,
  case when cidade in (select cidade from maiores) then cidade else 'Outras' end as cidade,
  cast(count(*) as double) as contratos,
  cast(count(*) filter (where cancelado_em is not null and cancelado_em <= fim
                           and coalesce(motivo_codigo, '') not in ('FNC.CAN.020', 'OTR.CAN.006')) as double) as cancelaram
from expostos
group by 1, 2, 3, 4
order by 1, 2, 3, 4` },
      { kind: 'python', source: py`${PRELUDIO}
d = tabela(df)
d = d[d["contratos"] > 0].reset_index(drop=True)
d["ficaram"] = d["contratos"] - d["cancelaram"]
geral = d["cancelaram"].sum() / d["contratos"].sum()
print(f"{num(d['contratos'].sum())} contratos expostos, {num(d['cancelaram'].sum())} cancelaram em 12 meses "
      f"({num(100 * geral, 1)}%; {len(d)} segmentos).")
fatores = ["tempo_de_casa", "faixa_valor", "pessoa", "cidade"]
for f in fatores:
    g = d.groupby(f)[["contratos", "cancelaram"]].sum()
    g["cancelaram_pct"] = (100 * g["cancelaram"] / g["contratos"]).round(1)
    print(f"\n{f} (taxa observada em 12 meses, sem controlar os outros fatores):")
    print(g.astype({"contratos": int, "cancelaram": int}).to_string())
` },
      { kind: 'python', source: py`import statsmodels.api as sm
import matplotlib.pyplot as plt

referencia = {}
X = pd.DataFrame(index=d.index)
for f in fatores:
    ref = d.groupby(f)["contratos"].sum().idxmax()
    referencia[f] = ref
    for nivel in sorted(d[f].unique()):
        if nivel != ref:
            X[f"{f}: {nivel}"] = (d[f] == nivel).astype(float)
X = sm.add_constant(X)
y = np.column_stack([d["cancelaram"].values, d["ficaram"].values])
modelo = sm.GLM(y, X, family=sm.families.Binomial()).fit()

ic = np.exp(modelo.conf_int())
efeitos = pd.DataFrame({
    "razao_de_chances": np.exp(modelo.params).round(2),
    "ic95_min": ic[0].round(2), "ic95_max": ic[1].round(2),
    "p_valor": modelo.pvalues.round(4),
}).drop(index="const").sort_values("razao_de_chances", ascending=False)
print("Referências:", "; ".join(f"{k} = {v}" for k, v in referencia.items()))
print("\nEfeito de cada fator com os outros fixos (razão de chances; acima de 1 = cancela mais):")
print(efeitos.to_string())
print(f"\nCalibração: o modelo espera {num(modelo.fittedvalues.mul(d['contratos']).sum())} cancelamentos; aconteceram {num(d['cancelaram'].sum())}.")

e = efeitos.iloc[::-1]
fig, ax = plt.subplots(figsize=(8, 0.32 * len(e) + 1))
ax.errorbar(e["razao_de_chances"], range(len(e)),
            xerr=[e["razao_de_chances"] - e["ic95_min"], e["ic95_max"] - e["razao_de_chances"]],
            fmt="o", color="#880F17", ecolor="#888888", capsize=2)
ax.axvline(1, color="#444444", lw=1)
ax.set_yticks(range(len(e)))
ax.set_yticklabels(e.index, fontsize=8)
ax.set_xscale("log")
ax.set_xlabel("razão de chances (escala log; 1 = igual à referência)")
ax.set_title("O que muda a chance de cancelar em 12 meses")
ax.grid(alpha=0.3, axis="x")
plt.show()
` },
      { kind: 'python', source: py`d["prob_12m_pct"] = (100 * modelo.fittedvalues).round(1)
d["cancelamentos_esperados"] = (modelo.fittedvalues * d["contratos"]).round(0)
foco = d[d["contratos"] >= 100].sort_values("cancelamentos_esperados", ascending=False).head(12)
print("Segmentos que mais devem perder contratos nos próximos 12 meses (mínimo de 100 contratos):")
print(foco[fatores + ["contratos", "prob_12m_pct", "cancelamentos_esperados"]]
      .astype({"contratos": int, "cancelamentos_esperados": int}).to_string(index=False))
participacao = foco["cancelamentos_esperados"].sum() / d["cancelamentos_esperados"].sum()
print(f"\nEsses 12 segmentos concentram {num(100 * participacao, 0)}% dos cancelamentos esperados.")
` },
      { kind: 'markdown', source: `## Como ler

- A **razão de chances** isola o fator. Um exemplo: se "até 6 meses" aparece com 2,0, contratos novos cancelam 2 vezes mais que a referência **na mesma faixa de valor, tipo de pessoa e cidade**.
- p-valor acima de 0,05 = o efeito pode ser acaso. Não tome decisão em cima dele.
- A lista de segmentos é a **fila de retenção**: onde uma ação preventiva (contato, upgrade, revisão de cobrança) evita mais perda.
- O modelo mostra associação, não causa. Para provar que uma ação funciona, teste com grupo de controle.` },
    ],
  },

  // ── 4. Curva de recebimento e perda esperada ─────────────────────────────
  {
    slug: 'analise_financeiro_curva_de_recebimento', domain: 'financeiro',
    name: 'Curva de recebimento e perda esperada',
    description: 'Para cada mês de vencimento, quanto do faturado já foi pago no vencimento, em D+5, D+15, D+30, D+60, D+90 e D+180. Os meses maduros mostram a perda real; os recentes têm o recebimento final projetado pelo ritmo dos maduros (chain-ladder).',
    cells: [
      { kind: 'markdown', source: `# Curva de recebimento e perda esperada

**Pergunta:** quanto do que faturamos a gente recebe, e em quanto tempo? Quanto dos meses recentes provavelmente não volta?

**Fonte:** \`prata_voalle_faturas\`: só a fatura que o cliente recebe (sem componentes), sem tarifa de baixa, vencidas até hoje e dos últimos 24 meses. Fatura renegociada fica numa coluna à parte: o saldo dela virou título novo, não é perda.

**Método:** curva de recebimento por mês de vencimento (safra de cobrança). Os meses com 180 dias ou mais de vencidos dão a curva completa. Para os mais novos, o recebimento final é projetado com os fatores de evolução dos meses completos (chain-ladder, o método de provisão de crédito).

${AVISO_ORDEM}` },
      { kind: 'sql', source: `select cast(date_trunc('month', vence_em) as date) as mes_vencimento,
  sum(valor) as valor_faturado,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 0), 0) as pago_d0,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 5), 0) as pago_d5,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 15), 0) as pago_d15,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 30), 0) as pago_d30,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 60), 0) as pago_d60,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 90), 0) as pago_d90,
  coalesce(sum(valor) filter (where paga and dias_pagamento_apos_vencimento <= 180), 0) as pago_d180,
  coalesce(sum(valor) filter (where paga), 0) as pago_total,
  coalesce(sum(valor) filter (where renegociada), 0) as renegociado,
  coalesce(sum(saldo) filter (where not renegociada), 0) as em_aberto,
  cast(date_diff('day', max(vence_em), current_date) as double) as dias_desde_o_vencimento
from prata_voalle_faturas
where vence_em < current_date
  and vence_em >= cast(date_trunc('month', current_date) - interval 24 month as date)
group by 1
order by 1` },
      { kind: 'python', source: py`${PRELUDIO}
import matplotlib.pyplot as plt
v = tabela(df).sort_values("mes_vencimento").reset_index(drop=True)
marcos = [("D0", "pago_d0", 0), ("D+5", "pago_d5", 5), ("D+15", "pago_d15", 15), ("D+30", "pago_d30", 30),
          ("D+60", "pago_d60", 60), ("D+90", "pago_d90", 90), ("D+180", "pago_d180", 180)]
curva = pd.DataFrame(index=v["mes_vencimento"].dt.strftime("%m/%Y"))
for rotulo, col, dia in marcos:
    pct = 100 * v[col] / v["valor_faturado"]
    # Mês que ainda não chegou ao marco não tem o número final: fica em branco.
    curva[rotulo] = np.where(v["dias_desde_o_vencimento"] >= dia, pct.round(1), np.nan)
curva["renegociado"] = (100 * v["renegociado"] / v["valor_faturado"]).round(1).values
curva["em_aberto"] = (100 * v["em_aberto"] / v["valor_faturado"]).round(1).values
print("% do faturado já recebido em cada marco, por mês de vencimento (em branco = mês ainda não chegou lá):")
print(curva.fillna("").to_string())

fig, ax = plt.subplots(figsize=(8, 3.8))
dias = [m[2] for m in marcos]
for i in range(max(0, len(v) - 12), len(v)):
    pontos = [(d_, 100 * v.loc[i, c] / v.loc[i, "valor_faturado"]) for _, c, d_ in marcos if v.loc[i, "dias_desde_o_vencimento"] >= d_]
    if pontos:
        xs, ys = zip(*pontos)
        ax.plot(xs, ys, marker="o", ms=2.5, lw=1, label=v.loc[i, "mes_vencimento"].strftime("%m/%y"))
ax.set_xscale("symlog", linthresh=5)
ax.set_xticks(dias)
ax.set_xticklabels([m[0] for m in marcos])
ax.set_ylabel("% do faturado recebido")
ax.set_title("Curva de recebimento por mês de vencimento (últimos 12)")
ax.grid(alpha=0.3)
ax.legend(fontsize=7, ncol=2)
plt.show()
` },
      { kind: 'python', source: py`# Fatores de evolução entre marcos, só com os meses que já passaram dos dois.
fatores_ev = {}
for (r1, c1, d1), (r2, c2, d2) in zip(marcos[:-1], marcos[1:]):
    ok = v["dias_desde_o_vencimento"] >= d2
    fatores_ev[(d1, d2)] = v.loc[ok, c2].sum() / v.loc[ok, c1].sum() if ok.any() and v.loc[ok, c1].sum() > 0 else 1.0
print("Quanto o recebido cresce de um marco ao seguinte (média dos meses completos):")
for (d1, d2), f in fatores_ev.items():
    print(f"  D+{d1:<3} -> D+{d2:<3}  x{num(f, 3)}")

projecao = []
cedo = []
for _, linha in v.iterrows():
    # Antes de D+30 a projeção é chute: em D0 metade ainda vai pagar no prazo de costume.
    if linha["dias_desde_o_vencimento"] < 30:
        cedo.append(linha["mes_vencimento"].strftime("%m/%Y"))
        continue
    ultimo = [m for m in marcos if linha["dias_desde_o_vencimento"] >= m[2]]
    _, col, dia = ultimo[-1]
    final = linha[col]
    for (d1, d2), f in fatores_ev.items():
        if d1 >= dia:
            final *= f
    perda = max(linha["valor_faturado"] - final - linha["renegociado"], 0)
    projecao.append({"vencimento": linha["mes_vencimento"].strftime("%m/%Y"),
                     "faturado": linha["valor_faturado"], "recebido_ate_d180_projetado": final,
                     "perda_esperada": perda, "perda_pct": 100 * perda / linha["valor_faturado"],
                     "situacao": "completo" if dia == 180 else f"projetado a partir de D+{dia}"})
p = pd.DataFrame(projecao).set_index("vencimento")
maduros = p[p["situacao"] == "completo"]
if len(maduros):
    print(f"\nPerda real dos meses completos: {num(100 * maduros['perda_esperada'].sum() / maduros['faturado'].sum(), 2)}% do faturado")
recentes = p[p["situacao"] != "completo"]
print(f"Perda esperada dos meses ainda em cobrança: {brl(recentes['perda_esperada'].sum())}")
if cedo:
    print(f"Fora da projeção (vencidos há menos de 30 dias): {', '.join(cedo)}")
print("\nPor mês (R$):")
saida = p.copy()
for c in ["faturado", "recebido_ate_d180_projetado", "perda_esperada"]:
    saida[c] = saida[c].map(brl)
saida["perda_pct"] = p["perda_pct"].map(lambda x: num(x, 2) + "%")
print(saida.to_string())
` },
      { kind: 'markdown', source: `## Como ler

- **D0** é a fatia paga até o vencimento. Ela mede o hábito de pagamento (Pix, débito, boleto antecipado). Se a curva de um mês começa mais baixa, a cobrança vai trabalhar mais.
- **Perda esperada** é o que, no ritmo de hoje, não deve entrar nem em 180 dias. É o número para provisão e para comparar réguas de cobrança.
- Quase todo saldo antigo em aberto é de contrato já cancelado: depois de 90 dias, a chance de receber cai muito.
- Fatura renegociada não é perda: o valor foi para títulos novos.` },
    ],
  },

  // ── 5. Receita contratada: ponte e projeção ─────────────────────────────
  {
    slug: 'analise_receita_ponte_e_projecao', domain: 'base',
    name: 'Receita contratada: ponte mensal e projeção da base',
    description: 'Quanto da receita contratada entra com instalações e sai com cancelamentos a cada mês, o índice de crescimento (quick ratio), o tamanho máximo da base no ritmo atual e a projeção da base e da receita para 12 meses em três cenários.',
    cells: [
      { kind: 'markdown', source: `# Receita contratada: ponte mensal e projeção

**Pergunta:** quanto a venda nova repõe do que se perde em cancelamento? Onde a base vai estar em 12 meses?

**Fontes:** \`ouro_base_ativa_mensal\`, \`ouro_receita_movimentacao_mensal\` e \`ouro_base_movimentacao_mensal\`. Só meses fechados.

**Método:** ponte da receita (início + nova − cancelada − lote = fim). O **quick ratio** é receita nova ÷ receita cancelada (acima de 1 = cresce). A projeção usa a dinâmica da base, B(t+1) = B(t) × (1 − churn) + instalações, com a média dos últimos 6 meses.

**Limite importante:** o conjunto guarda só o valor **atual** de cada contrato, sem o histórico. A ponte mostra o efeito de entrada e saída de contratos; reajuste de preço e troca de plano não aparecem. Para medir reajuste, use o faturamento (\`ouro_financeiro_faturamento_mensal\`).

${AVISO_ORDEM}` },
      { kind: 'sql', source: `select b.mes,
  cast(b.contratos_ativos as double) as contratos_ativos,
  b.receita_contratada, b.arpu,
  r.receita_nova, r.receita_cancelada, r.receita_cancelada_em_lote,
  cast(m.instalacoes as double) as instalacoes,
  cast(m.cancelamentos as double) as cancelamentos,
  cast(m.cancelamentos_em_lote as double) as cancelamentos_em_lote
from ouro_base_ativa_mensal b
left join ouro_receita_movimentacao_mensal r on r.mes = b.mes
left join ouro_base_movimentacao_mensal m on m.mes = b.mes
where b.mes < date_trunc('month', current_date)
order by b.mes` },
      { kind: 'python', source: py`${PRELUDIO}
r = tabela(df).sort_values("mes").set_index("mes")
r["receita_inicio"] = r["receita_contratada"].shift(1)
r["quick_ratio"] = r["receita_nova"] / r["receita_cancelada"].where(r["receita_cancelada"] > 0)
ponte = r.dropna(subset=["receita_inicio"]).tail(12)
tab = pd.DataFrame({
    "início": ponte["receita_inicio"].map(brl),
    "+ nova": ponte["receita_nova"].map(brl),
    "- cancelada": ponte["receita_cancelada"].map(brl),
    "- lote": ponte["receita_cancelada_em_lote"].map(brl),
    "fim": ponte["receita_contratada"].map(brl),
    "quick ratio": ponte["quick_ratio"].round(2),
})
tab.index = tab.index.strftime("%m/%Y")
print("Ponte da receita contratada (últimos 12 meses fechados):")
print(tab.to_string())
ini, fim = ponte["receita_inicio"].iloc[0], ponte["receita_contratada"].iloc[-1]
print(f"\nEm 12 meses: {brl(ini)} -> {brl(fim)} ({num(100 * (fim / ini - 1), 1)}%).")
print(f"Nova {brl(ponte['receita_nova'].sum())} | cancelada {brl(ponte['receita_cancelada'].sum())} | "
      f"lote {brl(ponte['receita_cancelada_em_lote'].sum())} | quick ratio do período "
      f"{num(ponte['receita_nova'].sum() / ponte['receita_cancelada'].sum(), 2)}")
if len(r) >= 13:
    print(f"Ticket médio: R$ {num(r['arpu'].iloc[-13], 2)} -> R$ {num(r['arpu'].iloc[-1], 2)} em 12 meses "
          "(efeito de quem entrou e saiu; reajuste não aparece — ver o texto acima).")
` },
      { kind: 'python', source: py`import matplotlib.pyplot as plt
r["base_inicio"] = r["contratos_ativos"].shift(1)
r["churn"] = r["cancelamentos"] / r["base_inicio"]
ult6 = r.dropna(subset=["churn"]).tail(6)
churn, instal = ult6["churn"].mean(), ult6["instalacoes"].mean()
base0, arpu0 = r["contratos_ativos"].iloc[-1], r["arpu"].iloc[-1]
receita0 = r["receita_contratada"].iloc[-1]
print(f"Últimos 6 meses: churn médio {num(100 * churn, 2)}% ao mês e {num(instal)} instalações por mês.")
print(f"Ponto de equilíbrio (onde a base para de crescer): {num(instal / churn)} contratos (hoje: {num(base0)}).")

cenarios = {"pessimista": (1.2, 0.85), "base": (1.0, 1.0), "otimista": (0.8, 1.15)}
meses = pd.period_range(r.index[-1], periods=13, freq="M")[1:]
proj = {}
for nome, (fc, fi) in cenarios.items():
    b, serie_b = base0, []
    for _ in meses:
        b = b * (1 - churn * fc) + instal * fi
        serie_b.append(b)
    proj[nome] = serie_b
proj = pd.DataFrame(proj, index=meses.strftime("%m/%Y"))
print("\nBase projetada (contratos) — pessimista: churn +20% e instalações -15%; otimista: o inverso:")
print(proj.iloc[[2, 5, 8, 11]].round(0).astype(int).to_string())
fator = receita0 / base0
print(f"\nReceita contratada em 12 meses, mantido o ticket de hoje: "
      + " | ".join(f"{k} {brl(proj[k].iloc[-1] * fator)}" for k in proj.columns))

fig, ax = plt.subplots(figsize=(9, 3.6))
hist = r["contratos_ativos"]
ax.plot(hist.index, hist.values, color="#333333", lw=1.8, label="realizado")
fx = meses.to_timestamp()
for nome, cor in [("pessimista", "#B5651D"), ("base", "#880F17"), ("otimista", "#2E7D32")]:
    ax.plot(fx, proj[nome].values, ls="--", color=cor, label=nome)
ax.set_ylabel("contratos ativos")
ax.set_title("Base ativa: realizado e projeção de 12 meses")
ax.grid(alpha=0.3)
ax.legend(fontsize=8)
plt.show()
` },
      { kind: 'markdown', source: `## Como ler

- **Quick ratio abaixo de 1** = a receita nova não repõe a perdida. Crescer nesse caso depende de reajuste.
- O **ponto de equilíbrio** mostra o tamanho máximo da base no ritmo atual. Para passar dele, é preciso vender mais ou perder menos.
- A projeção supõe o ritmo dos últimos 6 meses. Campanha, venda de lote ou mudança de preço mudam tudo.` },
    ],
  },

  // ── 6. Cidades e bairros: cancelamento fora do padrão ───────────────────
  {
    slug: 'analise_cancelamento_cidades_e_bairros', domain: 'cancelamento',
    name: 'Cidades e bairros: concentração e cancelamento fora do padrão',
    description: 'Quanto da base está em poucas cidades, quais cidades e bairros cancelam acima do esperado de forma estatisticamente significativa (gráfico de funil com limites de controle), quantos contratos isso custa e a relação com a inadimplência.',
    cells: [
      { kind: 'markdown', source: `# Cidades e bairros: cancelamento fora do padrão

**Pergunta:** dependemos de poucas cidades? Em que cidades e bairros o cancelamento está alto de verdade, e não por acaso de lugar pequeno?

**Fontes:**
- \`ouro_cancelamento_por_cidade_12m\`, \`ouro_base_ativa_por_cidade\` e \`ouro_financeiro_inadimplencia_por_cidade\`, para as cidades com base média de 30 contratos ou mais.
- \`prata_voalle_contratos\`, para os bairros com 80 contratos ou mais ativos no início da janela (os últimos 12 meses fechados).

**Método:** gráfico de funil. A taxa de cada lugar é comparada com a média geral usando limites que se abrem para lugares pequenos, onde o acaso pesa mais. Ficar acima do limite de 99,8% quer dizer que o problema é real.

${AVISO_ORDEM}` },
      { kind: 'sql', source: `with bc as (
    select cidade, sum(contratos) as contratos_hoje, sum(receita_contratada) as receita_contratada
      from ouro_base_ativa_por_cidade group by 1
  ), ic as (
    select cidade, sum(contratos_em_atraso_30d) as em_atraso, sum(contratos_ativos) as ativos
      from ouro_financeiro_inadimplencia_por_cidade group by 1
  )
select c.cidade, c.base_media,
  cast(c.cancelamentos_12m as double) as cancelamentos_12m,
  cast(bc.contratos_hoje as double) as contratos_hoje,
  bc.receita_contratada,
  round(100.0 * ic.em_atraso / nullif(ic.ativos, 0), 2) as contratos_em_atraso_pct
from ouro_cancelamento_por_cidade_12m c
left join bc on bc.cidade = c.cidade
left join ic on ic.cidade = c.cidade
where c.base_media >= 30
order by c.base_media desc` },
      { kind: 'python', source: py`${PRELUDIO}
c = tabela(df).fillna({"contratos_hoje": 0, "receita_contratada": 0})
part = c["contratos_hoje"] / c["contratos_hoje"].sum()
ordenada = part.sort_values(ascending=False)
print(f"{len(c)} cidades com base média de 30 contratos ou mais.")
for n in [1, 3, 5, 10]:
    if len(ordenada) >= n:
        print(f"  As {n:>2} maiores concentram {num(100 * ordenada.head(n).sum(), 1)}% da base")
hhi = float((part ** 2).sum() * 10000)
nivel = "baixa" if hhi < 1500 else ("moderada" if hhi < 2500 else "alta")
print(f"Índice de concentração (HHI): {num(hhi)} -> concentração {nivel}")
top = c.assign(participacao_pct=(100 * part).round(1)).sort_values("contratos_hoje", ascending=False).head(10)
top["receita_contratada"] = top["receita_contratada"].map(brl)
print("\nMaiores cidades:")
print(top[["cidade", "contratos_hoje", "participacao_pct", "receita_contratada"]].astype({"contratos_hoje": int}).to_string(index=False))
` },
      { kind: 'python', source: py`from scipy import stats
cores = {"acima (99,8%)": "#880F17", "acima (95%)": "#E07B00", "abaixo (95%)": "#2E7D32", "dentro do esperado": "#9E9E9E"}

def funil(t, casos, expostos):
    """Compara cada linha com a taxa média: z, cancelamentos esperados, excesso e situação."""
    p0 = t[casos].sum() / t[expostos].sum()
    erro = np.sqrt(p0 * (1 - p0) / t[expostos])
    t = t.assign(z=(t[casos] / t[expostos] - p0) / erro, esperado=p0 * t[expostos])
    t["excesso"] = t[casos] - t["esperado"]
    t["situacao"] = np.select([t["z"] > 3.09, t["z"] > 1.96, t["z"] < -1.96],
                              ["acima (99,8%)", "acima (95%)", "abaixo (95%)"], "dentro do esperado")
    return t, p0

c["exposicao"] = c["base_media"] * 12
c, p_cidade = funil(c, "cancelamentos_12m", "exposicao")
c["taxa_mensal_pct"] = 100 * c["cancelamentos_12m"] / c["exposicao"]
print(f"Cidades — taxa média de referência: {num(100 * p_cidade, 2)}% ao mês.")
print(c.sort_values("excesso", ascending=False)[["cidade", "base_media", "cancelamentos_12m", "taxa_mensal_pct", "excesso", "situacao", "contratos_em_atraso_pct"]]
      .round({"taxa_mensal_pct": 2, "excesso": 0, "base_media": 0}).to_string(index=False))
ok = c["contratos_em_atraso_pct"].notna()
if ok.sum() >= 8:
    rho, pv = stats.spearmanr(c.loc[ok, "taxa_mensal_pct"], c.loc[ok, "contratos_em_atraso_pct"])
    print(f"\nCorrelação (Spearman) entre cancelamento e % de contratos em atraso, por cidade: {num(rho, 2)} (p = {pv:.3f}; {ok.sum()} cidades)")
` },
      { kind: 'sql', source: `with p as (
    select cast(date_trunc('month', current_date) - interval 12 month as date) as ini,
           cast(date_trunc('month', current_date) - interval 1 day as date) as fim
  ), expostos as (
    select coalesce(c.cidade, 'Sem cidade') as cidade,
           coalesce(nullif(upper(trim(c.bairro)), ''), 'SEM BAIRRO') as bairro,
           c.cancelado_em, c.motivo_codigo, p.fim
      from prata_voalle_contratos c, p
     where c.instalado and c.instalado_em < p.ini
       and (c.cancelado_em is null or c.cancelado_em >= p.ini)
       and not (c.cancelado_em_lote and c.cancelado_em <= p.fim)
  )
select cidade, bairro,
  cast(count(*) as double) as contratos,
  cast(count(*) filter (where cancelado_em is not null and cancelado_em <= fim
                           and coalesce(motivo_codigo, '') not in ('FNC.CAN.020', 'OTR.CAN.006')) as double) as cancelaram
from expostos
group by 1, 2
having count(*) >= 80
order by contratos desc
limit 450` },
      { kind: 'python', source: py`import matplotlib.pyplot as plt
b = tabela(df)
b, p_bairro = funil(b, "cancelaram", "contratos")
b["cancelaram_12m_pct"] = (100 * b["cancelaram"] / b["contratos"]).round(1)
print(f"{len(b)} bairros com 80 contratos ou mais; taxa média em 12 meses: {num(100 * p_bairro, 1)}%.")
print(b["situacao"].value_counts().to_string())
alerta = b[b["z"] > 3.09].sort_values("excesso", ascending=False)
if len(alerta):
    print(f"\nBairros acima do esperado com 99,8% de confiança ({len(alerta)}), por contratos perdidos além do normal:")
    print(alerta.head(20)[["cidade", "bairro", "contratos", "cancelaram", "cancelaram_12m_pct", "excesso"]]
          .astype({"contratos": int, "cancelaram": int}).round({"excesso": 0}).to_string(index=False))
    por_cidade = alerta.groupby("cidade").agg(bairros=("bairro", "count"), excesso=("excesso", "sum")).sort_values("excesso", ascending=False)
    print("\nOnde estão esses bairros:")
    print(por_cidade.round(0).astype(int).to_string())
    print(f"\nEm conjunto, eles perderam {num(alerta['excesso'].sum())} contratos a mais que a média em 12 meses.")

fig, ax = plt.subplots(figsize=(8.5, 4))
for sit, g in b.groupby("situacao"):
    ax.scatter(g["contratos"], g["cancelaram_12m_pct"], s=12, color=cores[sit], label=sit, alpha=0.85)
xs = np.linspace(b["contratos"].min(), b["contratos"].max(), 200)
for zz, estilo in [(1.96, ":"), (3.09, "--")]:
    lim = np.sqrt(p_bairro * (1 - p_bairro) / xs)
    ax.plot(xs, 100 * (p_bairro + zz * lim), color="#555555", ls=estilo, lw=1)
    ax.plot(xs, 100 * np.clip(p_bairro - zz * lim, 0, None), color="#555555", ls=estilo, lw=1)
ax.axhline(100 * p_bairro, color="#333333", lw=1)
ax.set_xscale("log")
ax.set_xlabel("contratos no início da janela (escala log)")
ax.set_ylabel("cancelaram em 12 meses (%)")
ax.set_title("Funil: cancelamento por bairro × tamanho")
ax.grid(alpha=0.3)
ax.legend(fontsize=7)
plt.show()
` },
      { kind: 'markdown', source: `## Como ler

- Ponto **acima da linha tracejada** = cancelamento alto demais para ser acaso. Comece a investigação por ele: rede, concorrente novo, equipe técnica, cobrança.
- O **excesso** diz quantos contratos o lugar perdeu além do normal em 12 meses. Ordene a ação por ele, não pela taxa.
- Com centenas de bairros, uns poucos passam do limite de 95% por acaso. O de 99,8% é o que vale para agir.
- Correlação forte com atraso indica que o cancelamento ali é mais financeiro (inadimplência) do que de serviço.
- Concentração alta (HHI acima de 2.500) é risco de negócio: um problema numa cidade grande pesa na empresa toda.
- Cidade cuja base caiu quase a zero (ex.: saída de operação) aparece com taxa enorme. Confirme o motivo antes de tratar como problema de serviço.` },
    ],
  },
]
