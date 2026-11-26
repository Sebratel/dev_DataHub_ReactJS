// ─────────────────────────────────────────────────────────────────────────
// Compatibilidade com o SQL do Postgres (pedido de 26/11/2026).
//
// Quem escreve SQL no Data Hub copia a consulta do Voalle (Postgres) e cola no
// calculado, no notebook ou no modelo. O motor do lake é o DuckDB: a maior
// parte do SQL do Postgres roda igual, e o que não roda se divide em dois:
//   • o que dá ERRO: tabela com schema (erp.contracts), to_char, to_date,
//     to_number, initcap, unaccent, jsonb, json(b)_array_elements…;
//   • o que roda com RESULTADO DIFERENTE, sem aviso — o pior caso:
//       - `~` no DuckDB exige casar o texto inteiro; no Postgres basta conter;
//       - format('%s') devolve o molde literal;
//       - ::numeric sem precisão corta em 3 casas;
//       - LIKE com barra invertida não escapa.
//
// Aqui o SQL é reescrito ANTES da validação e da execução, só nesses pontos.
// Regra: só se reescreve o que é do Postgres; SQL que já é do DuckDB passa
// igual. SQL que não fecha parênteses volta como veio, e o erro de sintaxe
// continua sendo do DuckDB. Padrão do Postgres que não dá para reproduzir
// fielmente vira ERRO com explicação, nunca resultado aproximado.
//
// Gabarito: a saída do próprio Voalle (lc_numeric e lc_time pt_BR.UTF-8),
// conferida em 26/11/2026 e fixada em src/test/compatPostgres.test.ts.
//
// Diferenças que continuam (documentadas no RUNBOOK): divisão entre inteiros
// (5/2 = 2,5 aqui, 2 lá), SIMILAR TO e regexp_matches(), que existem nos dois
// com significados diferentes.
// ─────────────────────────────────────────────────────────────────────────

/** Tabela de fonte que pode ser citada como schema.tabela. */
export interface CompatTable { schema: string; table: string; slug: string }

export interface CompatResult {
  sql: string
  /** O que foi traduzido (para log e teste). */
  applied: string[]
}

/** Padrão do Postgres que não tem tradução fiel: a mensagem vai para quem escreveu. */
export class PgCompatError extends Error {
  constructor(message: string) { super(message); this.name = 'PgCompatError' }
}

// ── Tokens ───────────────────────────────────────────────────────────────
type TokKind = 'ws' | 'com' | 'str' | 'qid' | 'id' | 'num' | 'op' | 'cast' | 'punc' | 'param'
interface Tok { k: TokKind; v: string }
interface Grp { k: 'grp'; open: string; close: string; items: Item[] }
interface Raw { k: 'raw'; v: string }
type Item = Tok | Grp | Raw

const OP_CHARS = '+-*/<>=~!@#%^&|`?'
const ID_START = /[A-Za-z_\u0080-￿]/
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/

function tokenize(sql: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const rest2 = sql.slice(i, i + 2)
    if (/\s/.test(c)) {
      let j = i + 1
      while (j < n && /\s/.test(sql[j])) j++
      out.push({ k: 'ws', v: sql.slice(i, j) }); i = j; continue
    }
    if (rest2 === '--') {
      let j = sql.indexOf('\n', i)
      if (j < 0) j = n
      out.push({ k: 'com', v: sql.slice(i, j) }); i = j; continue
    }
    if (rest2 === '/*') {
      const j = sql.indexOf('*/', i + 2)
      if (j < 0) return null
      out.push({ k: 'com', v: sql.slice(i, j + 2) }); i = j + 2; continue
    }
    // E'…' (com escapes de barra) e '…' comum.
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const e = c !== "'"
      let j = i + (e ? 2 : 1)
      for (;;) {
        if (j >= n) return null
        if (e && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          break
        }
        j++
      }
      out.push({ k: 'str', v: sql.slice(i, j + 1) }); i = j + 1; continue
    }
    // $tag$…$tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const fim = sql.indexOf(m[0], i + m[0].length)
        if (fim < 0) return null
        out.push({ k: 'str', v: sql.slice(i, fim + m[0].length) }); i = fim + m[0].length; continue
      }
      const p = /^\$\d+/.exec(sql.slice(i))
      if (p) { out.push({ k: 'param', v: p[0] }); i += p[0].length; continue }
    }
    if (c === '"') {
      let j = i + 1
      for (;;) {
        if (j >= n) return null
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue }
          break
        }
        j++
      }
      out.push({ k: 'qid', v: sql.slice(i, j + 1) }); i = j + 1; continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!
      out.push({ k: 'num', v: m[0] }); i += m[0].length; continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < n && ID_PART.test(sql[j])) j++
      out.push({ k: 'id', v: sql.slice(i, j) }); i = j; continue
    }
    if (rest2 === '::') { out.push({ k: 'cast', v: '::' }); i += 2; continue }
    if (OP_CHARS.includes(c)) {
      let j = i + 1
      while (j < n && OP_CHARS.includes(sql[j]) && sql.slice(j, j + 2) !== '--' && sql.slice(j, j + 2) !== '/*') j++
      out.push({ k: 'op', v: sql.slice(i, j) }); i = j; continue
    }
    out.push({ k: 'punc', v: c }); i++
  }
  return out
}

function toTree(toks: Tok[]): Item[] | null {
  const raiz: Item[] = []
  const pilha: Grp[] = []
  const atual = () => (pilha.length ? pilha[pilha.length - 1].items : raiz)
  for (const t of toks) {
    if (t.k === 'punc' && (t.v === '(' || t.v === '[')) {
      const g: Grp = { k: 'grp', open: t.v, close: t.v === '(' ? ')' : ']', items: [] }
      atual().push(g)
      pilha.push(g)
    } else if (t.k === 'punc' && (t.v === ')' || t.v === ']')) {
      const g = pilha.pop()
      if (!g || g.close !== t.v) return null
    } else {
      atual().push(t)
    }
  }
  return pilha.length ? null : raiz
}

function render(items: Item[]): string {
  let s = ''
  for (const it of items) s += it.k === 'grp' ? it.open + render(it.items) + it.close : it.v
  return s
}

const sig = (it: Item | undefined) => !!it && it.k !== 'ws' && it.k !== 'com'
function nextSig(items: Item[], i: number): number {
  for (let j = i + 1; j < items.length; j++) if (sig(items[j])) return j
  return -1
}
function prevSig(items: Item[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (sig(items[j])) return j
  return -1
}
const isId = (it: Item | undefined, ...nomes: string[]) =>
  !!it && it.k === 'id' && (!nomes.length || nomes.includes(it.v.toLowerCase()))
const isPunc = (it: Item | undefined, v: string) => !!it && it.k === 'punc' && it.v === v
const isGrp = (it: Item | undefined): it is Grp => !!it && it.k === 'grp' && it.open === '('

/** Valor de um literal de texto ('…' ou $$…$$); null se o item não for um. */
function literal(items: Item[]): string | null {
  const s = items.filter(sig)
  if (s.length !== 1 || s[0].k !== 'str') return null
  const v = s[0].v
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(v)
  if (m) return v.slice(m[0].length, v.length - m[0].length)
  return null // E'…': escapes de barra, raro em formato — fica sem tradução
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`

function splitArgs(items: Item[]): Item[][] {
  const args: Item[][] = [[]]
  for (const it of items) {
    if (isPunc(it, ',')) args.push([])
    else args[args.length - 1].push(it)
  }
  return args.length === 1 && !args[0].some(sig) ? [] : args
}

// ── to_char e companhia: datas ───────────────────────────────────────────
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MESES_ABR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const DIAS_ABR = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const ROMANOS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

// Palavras do molde de data, como o Postgres: nomes (Month/MONTH/month) diferenciam
// maiúscula; os campos numéricos aceitam tudo maiúsculo ou tudo minúsculo.
const NUMERICOS = ['HH24', 'HH12', 'HH', 'MI', 'SSSSS', 'SSSS', 'SS', 'MS', 'US', 'Y,YYY', 'YYYY', 'YYY', 'YY', 'Y',
  'IYYY', 'IYY', 'IY', 'I', 'MM', 'DDD', 'DD', 'D', 'IDDD', 'ID', 'WW', 'W', 'IW', 'CC', 'J', 'Q', 'TZH', 'TZM', 'TZ', 'OF']
const NOMES = ['MONTH', 'Month', 'month', 'MON', 'Mon', 'mon', 'DAY', 'Day', 'day', 'DY', 'Dy', 'dy', 'RM', 'rm',
  'AM', 'am', 'PM', 'pm', 'A.M.', 'a.m.', 'P.M.', 'p.m.']
const PALAVRAS = [...new Set([...NUMERICOS, ...NUMERICOS.map((w) => w.toLowerCase()), ...NOMES])]
  .sort((a, b) => b.length - a.length)
const PREFIXOS = ['FM', 'fm', 'TM', 'tm', 'FX', 'fx']

type Peca = { fmt: string } | { sql: string } | { lit: string }

/** Lê o molde de data do Postgres e devolve as peças, na ordem. */
function pecasDeData(molde: string, paraLeitura: boolean): Peca[] {
  const pecas: Peca[] = []
  let i = 0
  while (i < molde.length) {
    if (molde[i] === '"') {
      let j = i + 1
      let txt = ''
      while (j < molde.length && molde[j] !== '"') {
        if (molde[j] === '\\' && j + 1 < molde.length) j++
        txt += molde[j]; j++
      }
      pecas.push({ lit: txt }); i = j + 1; continue
    }
    // Um prefixo só (FM, TM ou FX), e só vale se vier uma palavra logo depois:
    // é assim que o Postgres lê "FMTMMonth" como "T" + MM + "onth".
    let fm = false
    let tm = false
    const pre = PREFIXOS.find((p) => molde.startsWith(p, i))
    let k = i
    if (pre) {
      const depois = PALAVRAS.find((w) => molde.startsWith(w, i + 2))
      if (depois) { fm = /fm/i.test(pre); tm = /tm/i.test(pre); k = i + 2 }
    }
    const w = PALAVRAS.find((p) => molde.startsWith(p, k))
    if (!w) {
      // Prefixo sem palavra depois: o Postgres descarta o prefixo e toma o
      // caractere seguinte como texto ("FMTMMonth" → "T" + MM + "onth").
      if (pre) {
        if (i + 2 < molde.length) pecas.push({ lit: molde[i + 2] })
        i += 3; continue
      }
      pecas.push({ lit: molde[i] }); i++; continue
    }
    let fim = k + w.length
    if (/^(TH|th|SP)/.test(molde.slice(fim))) {
      throw new PgCompatError(`to_char: o sufixo "${molde.slice(fim, fim + 2)}" (ordinal/por extenso) ainda não é traduzido.`)
    }
    pecas.push(...pecaDeData(w, fm, tm, paraLeitura))
    i = fim
  }
  return pecas
}

function pecaDeData(w: string, fm: boolean, tm: boolean, leitura: boolean): Peca[] {
  const U = w.toUpperCase()
  const T = '__T__' // trocado pela expressão de data na montagem
  const nao = (o: string) => { throw new PgCompatError(`${leitura ? 'to_date/to_timestamp' : 'to_char'}: o campo "${o}" do molde ainda não é traduzido.`) }
  const caixa = (expr: string) => (w === U && w !== w.toLowerCase() ? `upper(${expr})` : w === w.toLowerCase() ? `lower(${expr})` : expr)
  if (leitura) {
    const m: Record<string, string> = {
      YYYY: '%Y', YY: '%y', MM: '%m', DD: '%d', HH24: '%H', HH12: '%I', HH: '%I', MI: '%M', SS: '%S', MS: '%g', US: '%f',
      AM: '%p', PM: '%p', MON: '%b', MONTH: '%B', DDD: '%j', DY: '%a', DAY: '%A',
    }
    const code = m[U]
    if (!code || tm) return nao(w)
    return [{ fmt: code }]
  }
  switch (U) {
    case 'HH24': return [{ fmt: fm ? '%-H' : '%H' }]
    case 'HH12': case 'HH': return [{ fmt: fm ? '%-I' : '%I' }]
    case 'MI': return [{ fmt: fm ? '%-M' : '%M' }]
    case 'SS': return [{ fmt: fm ? '%-S' : '%S' }]
    case 'MS': return [{ fmt: '%g' }]
    case 'US': return [{ fmt: '%f' }]
    case 'SSSS': case 'SSSSS': return [{ sql: `CAST(hour(${T}) * 3600 + minute(${T}) * 60 + second(${T}) AS VARCHAR)` }]
    case 'AM': case 'PM': return w === U ? [{ fmt: '%p' }] : [{ sql: `lower(strftime(${T}, '%p'))` }]
    case 'A.M.': case 'P.M.': {
      const s = `CASE WHEN hour(${T}) < 12 THEN 'A.M.' ELSE 'P.M.' END`
      return [{ sql: w === U ? s : `lower(${s})` }]
    }
    case 'YYYY': return [{ fmt: '%Y' }]
    case 'YYY': return [{ sql: `right(strftime(${T}, '%Y'), 3)` }]
    case 'YY': return [{ fmt: '%y' }]
    case 'Y': return [{ sql: `right(strftime(${T}, '%Y'), 1)` }]
    case 'IYYY': return [{ fmt: '%G' }]
    case 'IYY': return [{ sql: `right(strftime(${T}, '%G'), 3)` }]
    case 'IY': return [{ sql: `right(strftime(${T}, '%G'), 2)` }]
    case 'I': return [{ sql: `right(strftime(${T}, '%G'), 1)` }]
    case 'MM': return [{ fmt: fm ? '%-m' : '%m' }]
    case 'MONTH': {
      if (tm) return [{ sql: caixa(`${listaSql(MESES.map(capitaliza))}[month(${T})]`) }]
      const nome = `strftime(${T}, '%B')`
      return [{ sql: caixa(fm ? nome : `rpad(${nome}, 9, ' ')`) }]
    }
    case 'MON': {
      if (tm) return [{ sql: caixa(`${listaSql(MESES_ABR.map(capitaliza))}[month(${T})]`) }]
      return w === 'Mon' ? [{ fmt: '%b' }] : [{ sql: caixa(`strftime(${T}, '%b')`) }]
    }
    case 'DAY': {
      if (tm) return [{ sql: caixa(`${listaSql(DIAS.map(capitaliza))}[dayofweek(${T}) + 1]`) }]
      const nome = `strftime(${T}, '%A')`
      return [{ sql: caixa(fm ? nome : `rpad(${nome}, 9, ' ')`) }]
    }
    case 'DY': {
      if (tm) return [{ sql: caixa(`${listaSql(DIAS_ABR.map(capitaliza))}[dayofweek(${T}) + 1]`) }]
      return w === 'Dy' ? [{ fmt: '%a' }] : [{ sql: caixa(`strftime(${T}, '%a')`) }]
    }
    case 'DDD': return [{ fmt: fm ? '%-j' : '%j' }]
    case 'DD': return [{ fmt: fm ? '%-d' : '%d' }]
    case 'D': return [{ sql: `CAST(dayofweek(${T}) + 1 AS VARCHAR)` }]
    case 'ID': return [{ fmt: '%u' }]
    case 'WW': {
      const n = `CAST((dayofyear(${T}) - 1) // 7 + 1 AS VARCHAR)`
      return [{ sql: fm ? n : `lpad(${n}, 2, '0')` }]
    }
    case 'W': return [{ sql: `CAST((day(${T}) - 1) // 7 + 1 AS VARCHAR)` }]
    case 'IW': return fm ? [{ sql: `CAST(weekofyear(${T}) AS VARCHAR)` }] : [{ fmt: '%V' }]
    case 'CC': return [{ sql: `lpad(CAST((year(${T}) + 99) // 100 AS VARCHAR), 2, '0')` }]
    case 'J': return [{ sql: `CAST(date_diff('day', DATE '1970-01-01', CAST(${T} AS DATE)) + 2440588 AS VARCHAR)` }]
    case 'Q': return [{ sql: `CAST(quarter(${T}) AS VARCHAR)` }]
    case 'RM': {
      const r = `${listaSql(ROMANOS)}[month(${T})]`
      const s = fm ? r : `rpad(${r}, 4, ' ')`
      return [{ sql: w === 'rm' ? `lower(${s})` : s }]
    }
    default: return nao(w) // Y,YYY, IDDD, TZ, TZH, TZM, OF
  }
}

const capitaliza = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const listaSql = (xs: string[]) => `[${xs.map(q).join(', ')}]`

/** Junta as peças: trechos seguidos de strftime viram um strftime só. */
function montaData(pecas: Peca[], valor: string, funcao: 'strftime'): string {
  const T = `CAST((${valor}) AS TIMESTAMP)`
  const partes: string[] = []
  let buf = ''
  const despeja = () => { if (buf) { partes.push(`${funcao}(${T}, ${q(buf)})`); buf = '' } }
  for (const p of pecas) {
    if ('fmt' in p) buf += p.fmt
    else if ('lit' in p) buf += p.lit.replace(/%/g, '%%')
    else { despeja(); partes.push(p.sql.split('__T__').join(T)) }
  }
  despeja()
  if (!partes.length) return `CAST(NULL AS VARCHAR)`
  return partes.length === 1 ? partes[0] : `(${partes.join(' || ')})`
}

// ── to_char: números ─────────────────────────────────────────────────────
// lc_numeric do Voalle é pt_BR: G = ".", D = ",", L = "R$". "." e "," literais
// no molde valem como estão, igual ao Postgres.
const LOCALE = { group: '.', decimal: ',', currency: 'R$' }

function toCharNumero(valor: string, molde: string): string {
  let fm = false
  let i = 0
  const prefixo: string[] = [] // literais antes dos dígitos
  const sufixo: string[] = [] // literais depois
  const inteiro: ({ d: '9' | '0' } | { g: string })[] = []
  const frac: ('9' | '0')[] = []
  let decimal: string | null = null
  let viuDigito = false
  const lit = (s: string) => { (viuDigito ? sufixo : prefixo).push(s) }
  while (i < molde.length) {
    const c = molde[i]
    const dois = molde.slice(i, i + 2)
    if (dois === 'FM' || dois === 'fm') { fm = true; i += 2; continue }
    if (c === '"') {
      const j = molde.indexOf('"', i + 1)
      lit(molde.slice(i + 1, j < 0 ? molde.length : j)); i = j < 0 ? molde.length : j + 1; continue
    }
    if (c === '9' || c === '0') {
      if (sufixo.length) throw new PgCompatError(`to_char: o molde numérico "${molde}" tem texto entre os dígitos; ainda não é traduzido.`)
      viuDigito = true
      if (decimal == null) inteiro.push({ d: c }); else frac.push(c)
      i++; continue
    }
    if (c === 'D' || c === 'd' || c === '.') {
      if (decimal != null) throw new PgCompatError(`to_char: o molde "${molde}" tem dois separadores decimais.`)
      decimal = c === '.' ? '.' : LOCALE.decimal; viuDigito = true; i++; continue
    }
    if (c === 'G' || c === 'g' || c === ',') {
      if (decimal != null) throw new PgCompatError(`to_char: separador de milhar depois da vírgula em "${molde}".`)
      inteiro.push({ g: c === ',' ? ',' : LOCALE.group }); i++; continue
    }
    if (c === 'L' || c === 'l') { lit(LOCALE.currency); i++; continue }
    if (/[SsVvEeRrPpMmTt]/.test(c) && /^(S|MI|PL|SG|PR|V|EEEE|RN|rn|TH|th)/.test(molde.slice(i))) {
      throw new PgCompatError(`to_char: o campo "${molde.slice(i).match(/^(S|MI|PL|SG|PR|V|EEEE|RN|rn|TH|th)/)![0]}" do molde numérico ainda não é traduzido.`)
    }
    lit(c); i++
  }

  const digitos = inteiro.filter((x) => 'd' in x) as { d: '9' | '0' }[]
  const k = digitos.length
  const nf = frac.length
  const zeroDesde = digitos.findIndex((x) => x.d === '0') // 0-based; -1 = nenhum
  const pre = prefixo.join('')
  const suf = sufixo.join('')

  // Estouro: o Postgres troca cada dígito por "#".
  let estouro = ''
  for (const x of inteiro) estouro += 'd' in x ? '#' : x.g
  if (decimal != null) estouro += decimal + '#'.repeat(nf)
  estouro = (fm ? '' : ' ') + estouro

  // Inteiro: p = parte inteira alinhada à direita em k posições; a partir do
  // primeiro "0" do molde, espaço vira zero. Separador de milhar só sai se há
  // dígito à esquerda dele.
  const P = 'p'
  const corpo: string[] = []
  let pos = 0
  for (const x of inteiro) {
    if ('d' in x) {
      pos++
      corpo.push(`substr(${P}, ${pos}, 1)`)
    } else {
      corpo.push(pos === 0 ? `' '` : `CASE WHEN substr(${P}, ${pos}, 1) <> ' ' THEN ${q(x.g)} ELSE ' ' END`)
    }
  }
  const inteiroSql = corpo.length ? corpo.join(' || ') : `''`
  // Parte fracionária: no FM, os zeros finais em posição "9" somem.
  const obrig = frac.lastIndexOf('0') + 1
  const fracSql = nf === 0 ? `''`
    : fm ? `(substr(f, 1, ${obrig}) || rtrim(substr(f, ${obrig + 1}), '0'))` : 'f'
  const decSql = decimal == null ? '' : ` || ${q(decimal)} || ${fracSql}`

  const semSinal = `(${inteiroSql})${decSql}`
  const final = fm
    ? `CASE WHEN n < 0 THEN '-' ELSE '' END || ltrim(${semSinal})`
    : `regexp_replace(${semSinal}, '^( *)', '\\1' || CASE WHEN n < 0 THEN '-' ELSE ' ' END)`

  // Valor uma vez só (lambda sobre lista de um elemento), depois as partes.
  const arred = `CAST(round(abs(n), ${nf}) AS DECIMAL(38, ${nf}))`
  const partes = `list_transform([CAST(${arred} AS VARCHAR)], lambda s: ` +
    `list_transform([${nf > 0 ? `CASE WHEN split_part(s, '.', 1) = '0' THEN '' ELSE split_part(s, '.', 1) END` : `s`}], lambda ip: ` +
    `CASE WHEN length(ip) > ${k} THEN ${q(estouro)} ELSE ` +
    `list_transform([${zeroDesde >= 0
      ? `substr(lpad(ip, ${k}, ' '), 1, ${zeroDesde}) || replace(substr(lpad(ip, ${k}, ' '), ${zeroDesde + 1}), ' ', '0')`
      : `lpad(ip, ${k}, ' ')`}], lambda ${P}: ` +
    `list_transform([${nf > 0 ? `split_part(s, '.', 2)` : `''`}], lambda f: ${final})[1])[1] END)[1])[1]`
  return `list_transform([CAST((${valor}) AS DECIMAL(38, 10))], lambda n: ` +
    `CASE WHEN n IS NULL THEN NULL ELSE ${q(pre)} || ${partes} || ${q(suf)} END)[1]`
}

function toChar(args: string[], argItems: Item[][]): string {
  if (args.length !== 2) throw new PgCompatError('to_char: use to_char(valor, \'molde\').')
  const molde = literal(argItems[1])
  if (molde == null) throw new PgCompatError('to_char: o molde precisa ser um texto fixo entre aspas para ser traduzido.')
  const semAspas = molde.replace(/"[^"]*"/g, '')
  if (/[90]/.test(semAspas)) return toCharNumero(args[0], molde)
  return montaData(pecasDeData(molde, false), args[0], 'strftime')
}

function toDateOuTimestamp(nome: 'to_date' | 'to_timestamp', args: string[], argItems: Item[][]): string | null {
  if (nome === 'to_timestamp' && args.length === 1) return null // segundos desde 1970: o DuckDB já tem
  if (args.length !== 2) throw new PgCompatError(`${nome}: use ${nome}(texto, 'molde').`)
  const molde = literal(argItems[1])
  if (molde == null) throw new PgCompatError(`${nome}: o molde precisa ser um texto fixo entre aspas para ser traduzido.`)
  let fmt = ''
  for (const p of pecasDeData(molde, true)) {
    if ('fmt' in p) fmt += p.fmt
    else if ('lit' in p) fmt += p.lit.replace(/%/g, '%%')
  }
  const ts = `strptime(CAST((${args[0]}) AS VARCHAR), ${q(fmt)})`
  return nome === 'to_date' ? `CAST(${ts} AS DATE)` : ts
}

function toNumber(args: string[], argItems: Item[][]): string {
  if (args.length !== 2) throw new PgCompatError('to_number: use to_number(texto, \'molde\').')
  const molde = literal(argItems[1])
  if (molde == null) throw new PgCompatError('to_number: o molde precisa ser um texto fixo entre aspas para ser traduzido.')
  const sem = molde.replace(/"[^"]*"/g, '')
  const dec = /[Dd]/.test(sem) ? LOCALE.decimal : sem.includes('.') ? '.' : null
  const posDec = dec == null ? -1 : Math.max(sem.search(/[Dd]/), dec === '.' ? sem.indexOf('.') : -1)
  const nf = posDec < 0 ? 0 : (sem.slice(posDec + 1).match(/[90]/g) ?? []).length
  const classe = dec == null ? '[^0-9-]' : `[^0-9${dec === '.' ? '.' : ','}-]`
  let limpo = `regexp_replace(CAST((${args[0]}) AS VARCHAR), ${q(classe)}, '', 'g')`
  if (dec === ',') limpo = `replace(${limpo}, ',', '.')`
  return `CAST(${limpo} AS DECIMAL(38, ${nf}))`
}

// ── Número como texto ────────────────────────────────────────────────────
// O lake guarda toda coluna numérica como DOUBLE (ingest.ts): o id 1 do
// Voalle vira 1.0, e CAST(1.0 AS VARCHAR) é "1.0" — no Postgres, "1". Onde o
// SQL transforma explicitamente em texto, o número inteiro sai sem o ".0".
// O tipo é decidido pelo DuckDB na ligação (typeof é constante por coluna).
function comoTexto(expr: string): string {
  const e = `(${expr})`
  return `CASE WHEN typeof(${e}) IN ('DOUBLE', 'FLOAT') THEN regexp_replace(CAST(${e} AS VARCHAR), '\\.0$', '') ` +
    `ELSE CAST(${e} AS VARCHAR) END`
}

// ── format('%s') → printf ────────────────────────────────────────────────
function formatPg(args: string[], argItems: Item[][]): string | null {
  const molde = argItems.length ? literal(argItems[0]) : null
  // Molde do DuckDB ({}) ou não literal: é do DuckDB, fica como está.
  if (molde == null || !molde.includes('%') || molde.includes('{')) return null
  let saida = ''
  let usados = 0
  for (let i = 0; i < molde.length; i++) {
    if (molde[i] !== '%') { saida += molde[i]; continue }
    const m = /^%(-?\d*)([sIL%])/.exec(molde.slice(i))
    if (!m || /^%\d+\$/.test(molde.slice(i))) {
      throw new PgCompatError(`format: o especificador "${molde.slice(i, i + 3)}" ainda não é traduzido (use %s).`)
    }
    if (m[2] === '%') { saida += '%%'; i += 1; continue }
    if (m[2] !== 's') throw new PgCompatError(`format: "%${m[2]}" (identificador/literal SQL) não é traduzido; use %s.`)
    saida += `%${m[1]}s`; usados++; i += m[0].length - 1
  }
  // No Postgres, NULL em %s vira texto vazio; no printf, derrubaria tudo.
  const valores = args.slice(1, 1 + usados).map((a) => `coalesce(${comoTexto(a)}, '')`)
  if (valores.length < usados) throw new PgCompatError('format: há mais %s do que valores.')
  return `printf(${[q(saida), ...valores].join(', ')})`
}

function caminhoJson(argItems: Item[][], nome: string): string {
  let p = '$'
  for (const a of argItems) {
    const v = literal(a)
    if (v == null) throw new PgCompatError(`${nome}: as chaves do caminho precisam ser textos fixos entre aspas.`)
    p += /^\d+$/.test(v) ? `[${v}]` : `."${v.replace(/"/g, '\\"')}"`
  }
  return q(p)
}

/** '{a,b}' do Postgres → lista do DuckDB. */
function arrayLiteral(v: string): string | null {
  const m = /^\s*\{(.*)\}\s*$/s.exec(v)
  if (!m) return null
  if (!m[1].trim()) return '[]'
  const els: string[] = []
  let atual = ''
  let aspas = false
  let citado = false
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i]
    if (aspas) {
      if (c === '\\') { atual += m[1][++i] ?? ''; continue }
      if (c === '"') { aspas = false; continue }
      atual += c; continue
    }
    if (c === '"') { aspas = true; citado = true; continue }
    if (c === ',') { els.push(citado ? `\u0000${atual}` : atual.trim()); atual = ''; citado = false; continue }
    atual += c
  }
  els.push(citado ? `\u0000${atual}` : atual.trim())
  const numericos = els.every((e) => !e.startsWith('\u0000') && /^-?\d+(\.\d+)?$/.test(e))
  return `[${els.map((e) => {
    if (e.startsWith('\u0000')) return q(e.slice(1))
    if (/^null$/i.test(e)) return 'NULL'
    return numericos ? e : q(e)
  }).join(', ')}]`
}

type Tradutor = (args: string[], argItems: Item[][]) => string | null
const FUNCOES: Record<string, Tradutor> = {
  to_char: toChar,
  to_date: (a, i) => toDateOuTimestamp('to_date', a, i),
  to_timestamp: (a, i) => toDateOuTimestamp('to_timestamp', a, i),
  to_number: toNumber,
  initcap: (a) => {
    if (a.length !== 1) throw new PgCompatError('initcap: use initcap(texto).')
    // Maiúscula no começo de cada palavra; palavra = letras e números de
    // qualquer alfabeto (o Postgres em pt_BR faz "d'ávila" → "D'Ávila").
    return `list_transform([CAST((${a[0]}) AS VARCHAR)], lambda s: CASE WHEN s IS NULL THEN NULL ELSE ` +
      `array_to_string(list_transform(range(1, length(s) + 1), lambda i: CASE WHEN i = 1 OR NOT ` +
      `regexp_matches(s[i - 1], '[\\p{L}\\p{N}]') THEN upper(s[i]) ELSE lower(s[i]) END), '') END)[1]`
  },
  unaccent: (a) => `strip_accents(CAST((${a[a.length - 1]}) AS VARCHAR))`,
  format: formatPg,
  // concat/concat_ws: número inteiro sem ".0", como no Postgres (ver comoTexto).
  concat: (a) => (a.length ? `concat(${a.map(comoTexto).join(', ')})` : null),
  concat_ws: (a) => (a.length > 1 ? `concat_ws(${[a[0], ...a.slice(1).map(comoTexto)].join(', ')})` : null),
  div: (a) => {
    if (a.length !== 2) throw new PgCompatError('div: use div(a, b).')
    return `CAST(trunc((${a[0]}) / (${a[1]})) AS BIGINT)`
  },
  regexp_split_to_table: (a) => {
    if (a.length !== 2) throw new PgCompatError('regexp_split_to_table: a forma com opções ainda não é traduzida.')
    return `unnest(regexp_split_to_array(${a[0]}, ${a[1]}))`
  },
  json_array_elements_text: (a) => `unnest(json_extract_string(CAST((${a[0]}) AS JSON), '$[*]'))`,
  jsonb_array_elements_text: (a) => `unnest(json_extract_string(CAST((${a[0]}) AS JSON), '$[*]'))`,
  json_array_elements: (a) => `unnest(json_extract(CAST((${a[0]}) AS JSON), '$[*]'))`,
  jsonb_array_elements: (a) => `unnest(json_extract(CAST((${a[0]}) AS JSON), '$[*]'))`,
  json_extract_path_text: (a, i) => `json_extract_string(CAST((${a[0]}) AS JSON), ${caminhoJson(i.slice(1), 'json_extract_path_text')})`,
  jsonb_extract_path_text: (a, i) => `json_extract_string(CAST((${a[0]}) AS JSON), ${caminhoJson(i.slice(1), 'jsonb_extract_path_text')})`,
  json_extract_path: (a, i) => `json_extract(CAST((${a[0]}) AS JSON), ${caminhoJson(i.slice(1), 'json_extract_path')})`,
  jsonb_extract_path: (a, i) => `json_extract(CAST((${a[0]}) AS JSON), ${caminhoJson(i.slice(1), 'jsonb_extract_path')})`,
  any: (a, i) => {
    const v = a.length === 1 ? literal(i[0]) : null
    const lista = v == null ? null : arrayLiteral(v)
    return lista == null ? null : `any(${lista})`
  },
  all: (a, i) => {
    const v = a.length === 1 ? literal(i[0]) : null
    const lista = v == null ? null : arrayLiteral(v)
    return lista == null ? null : `all(${lista})`
  },
}

// Tipo do Postgres → DuckDB, em ::tipo e CAST(… AS tipo).
function tipo(nome: string, temPrecisao: boolean): string | null {
  const n = nome.toLowerCase()
  if (n === 'jsonb') return 'JSON'
  // numeric sem precisão no Postgres não arredonda; no DuckDB vira DECIMAL(18,3).
  if ((n === 'numeric' || n === 'decimal') && !temPrecisao) return 'DECIMAL(38, 10)'
  return null
}

// ── Reescrita ────────────────────────────────────────────────────────────
const REGEX_OPS: Record<string, { neg: boolean; ci: boolean }> = {
  '~': { neg: false, ci: false }, '~*': { neg: false, ci: true },
  '!~': { neg: true, ci: false }, '!~*': { neg: true, ci: true },
}

interface Ctx { tabelas: Map<string, string[]>; applied: Set<string> }

const nomeId = (it: Item) => (it.k === 'qid' ? it.v.slice(1, -1).replace(/""/g, '"') : (it as Tok).v.toLowerCase())

function rewriteSeq(items: Item[], ctx: Ctx): Item[] {
  // 1) de dentro para fora: o argumento já chega traduzido à função de fora
  let out: Item[] = items.map((it) => {
    if (it.k !== 'grp') return it
    return { ...it, items: rewriteSeq(it.items, ctx) }
  })

  // 2) schema.tabela, funções, tipos e LIKE com barra
  const res: Item[] = []
  for (let i = 0; i < out.length; i++) {
    const it = out[i]
    const ant = res.length ? res[prevSig(res, res.length)] : undefined

    if ((it.k === 'id' || it.k === 'qid') && !isPunc(ant, '.')) {
      // schema.tabela de uma fonte do lake → o nome do conjunto
      const p = nextSig(out, i)
      const t = p >= 0 ? nextSig(out, p) : -1
      if (p >= 0 && isPunc(out[p], '.') && t >= 0 && (out[t].k === 'id' || out[t].k === 'qid')) {
        const chave = `${nomeId(it)}.${nomeId(out[t])}`
        const slugs = ctx.tabelas.get(chave)
        if (slugs) {
          if (slugs.length > 1) {
            throw new PgCompatError(`"${chave}" existe em mais de uma conexão (${slugs.join(', ')}). Cite o conjunto pelo nome.`)
          }
          res.push({ k: 'raw', v: `"${slugs[0]}"` })
          ctx.applied.add(chave)
          i = t
          continue
        }
      }
    }

    if (it.k === 'id' && !isPunc(ant, '.')) {
      const nome = it.v.toLowerCase()
      const g = nextSig(out, i)
      if (g >= 0 && isGrp(out[g])) {
        const grp = out[g] as Grp
        if (nome === 'cast' || nome === 'try_cast') {
          const r = render(grp.items)
          // CAST(x AS text | varchar): número inteiro sem ".0" (ver comoTexto)
          const txt = /\bas\s+("?)(text|varchar)\1\s*$/i.exec(r)
          if (txt) {
            res.push({ k: 'raw', v: comoTexto(r.slice(0, txt.index).trim()) })
            ctx.applied.add(`cast ${txt[2].toLowerCase()}`)
            i = g
            continue
          }
          // CAST(x AS jsonb | numeric)
          const m = /\bas\s+("?)(jsonb|numeric|decimal)\1\s*$/i.exec(r)
          if (m) {
            const novo = tipo(m[2], false)!
            res.push(it, ...out.slice(i + 1, g), { ...grp, items: [{ k: 'raw', v: r.slice(0, m.index) + 'AS ' + novo }] })
            ctx.applied.add(`cast ${m[2].toLowerCase()}`)
            i = g
            continue
          }
        }
        const tradutor = FUNCOES[nome]
        if (tradutor) {
          const argItems = splitArgs(grp.items)
          const args = argItems.map((a) => render(a).trim())
          const sql = tradutor(args, argItems)
          if (sql != null) {
            res.push({ k: 'raw', v: sql })
            ctx.applied.add(nome)
            i = g
            continue
          }
        }
      }
    }

    // ::jsonb e ::numeric sem precisão
    if (it.k === 'cast') {
      const t = nextSig(out, i)
      if (t >= 0 && (out[t].k === 'id' || out[t].k === 'qid')) {
        const depois = nextSig(out, t)
        const novo = tipo(nomeId(out[t]), depois >= 0 && isGrp(out[depois]))
        if (novo) {
          res.push(it, { k: 'raw', v: novo })
          ctx.applied.add(`::${nomeId(out[t])}`)
          i = t
          continue
        }
      }
    }

    // LIKE/ILIKE com barra invertida: no Postgres a barra é o escape padrão.
    if (isId(it, 'like', 'ilike') && !isId(ant, 'similar')) {
      const s = nextSig(out, i)
      const depois = s >= 0 ? nextSig(out, s) : -1
      if (s >= 0 && out[s].k === 'str' && (out[s] as Tok).v.startsWith("'") && (out[s] as Tok).v.includes('\\')
        && !isId(out[depois], 'escape')) {
        res.push(...out.slice(i, s + 1), { k: 'raw', v: ` ESCAPE '\\'` })
        ctx.applied.add('like escape')
        i = s
        continue
      }
    }

    res.push(it)
  }
  out = res

  // 3) x::text / x::varchar: número inteiro sem ".0" (ver comoTexto). Antes
  // dos operadores: o cast prende mais que o "~".
  for (let i = 0; i < out.length; i++) {
    if (out[i].k !== 'cast') continue
    const t = nextSig(out, i)
    if (t < 0 || !isId(out[t], 'text', 'varchar')) continue
    const depois = nextSig(out, t)
    if (depois >= 0 && out[depois].k === 'grp') continue // varchar(10), text[]
    const l1 = prevSig(out, i)
    if (l1 < 0 || !operando(out[l1])) continue
    const l0 = inicioOperando(out, l1)
    out.splice(l0, t - l0 + 1, { k: 'raw', v: comoTexto(render(out.slice(l0, l1 + 1)).trim()) })
    ctx.applied.add('::text')
    i = l0
  }

  // 4) ~ ~* !~ !~* → regexp_matches (no DuckDB, "~" exige casar o texto inteiro)
  for (let i = 0; i < out.length; i++) {
    const it = out[i]
    if (it.k !== 'op' || !REGEX_OPS[it.v]) continue
    const l1 = prevSig(out, i)
    if (l1 < 0 || !operando(out[l1])) continue // "~" unário (negação de bits)
    const l0 = inicioOperando(out, l1)
    const r0 = nextSig(out, i)
    if (r0 < 0) continue
    const r1 = fimOperando(out, r0)
    if (r1 < 0) continue
    const { neg, ci } = REGEX_OPS[it.v]
    let dir = render(out.slice(r0, r1 + 1)).trim()
    // Fronteira de palavra do Postgres (\m, \M, \y) → \b
    if (out[r0].k === 'str' && r0 === r1) dir = dir.replace(/\\[mMy]/g, '\\b')
    const esq = render(out.slice(l0, l1 + 1)).trim()
    const base = `regexp_matches(${esq}, ${dir}${ci ? ", 'i'" : ''})`
    out.splice(l0, r1 - l0 + 1, { k: 'raw', v: neg ? `(NOT ${base})` : base })
    ctx.applied.add(it.v)
    i = l0
  }
  return out
}

// Palavras que nunca são operando (nem nome de função antes de um parêntese).
// "end" entra aqui: CASE … END ~ 'x' fica sem tradução — raro, e o operando
// inteiro não é recuperável só olhando para trás.
const PALAVRAS_SQL = new Set(['and', 'or', 'not', 'where', 'when', 'then', 'else', 'end', 'select', 'on', 'having',
  'case', 'by', 'in', 'exists', 'from', 'join', 'as', 'is', 'between', 'like', 'ilike', 'distinct', 'using', 'with',
  'return', 'all', 'any', 'some', 'union', 'except', 'intersect', 'limit', 'offset', 'order', 'group'])

function operando(it: Item): boolean {
  if (it.k === 'grp' || it.k === 'raw' || it.k === 'str' || it.k === 'num' || it.k === 'param' || it.k === 'qid') return true
  if (it.k === 'id') return !PALAVRAS_SQL.has(it.v.toLowerCase())
  return false
}

// Volta do fim do operando da esquerda até o começo: a.b.c, f(…), (…), x::tipo.
function inicioOperando(items: Item[], fim: number): number {
  let s = fim
  for (;;) {
    let cur = s
    // tipo de um cast: x::varchar(10) — volta por cima do tipo e do ::
    if (isGrp(items[cur])) {
      const p = prevSig(items, cur)
      if (p >= 0 && items[p].k === 'id' && operando(items[p])) cur = p
    }
    while (true) {
      const p = prevSig(items, cur)
      const pp = p >= 0 ? prevSig(items, p) : -1
      if (p >= 0 && isPunc(items[p], '.') && pp >= 0 && (items[pp].k === 'id' || items[pp].k === 'qid' || items[pp].k === 'raw')) cur = pp
      else break
    }
    const c = prevSig(items, cur)
    if (c >= 0 && items[c].k === 'cast') {
      const antes = prevSig(items, c)
      if (antes >= 0 && operando(items[antes])) { s = antes; continue }
    }
    return cur
  }
}

// Fim do operando da direita: literal, parâmetro, a.b.c, f(…), (…), seguido de ::tipo.
function fimOperando(items: Item[], ini: number): number {
  const it = items[ini]
  let fim: number
  if (it.k === 'str' || it.k === 'num' || it.k === 'param' || it.k === 'raw' || it.k === 'grp') fim = ini
  else if (it.k === 'id' || it.k === 'qid') {
    fim = ini
    while (true) {
      const p = nextSig(items, fim)
      const pp = p >= 0 ? nextSig(items, p) : -1
      if (p >= 0 && isPunc(items[p], '.') && pp >= 0 && (items[pp].k === 'id' || items[pp].k === 'qid')) fim = pp
      else break
    }
    const g = nextSig(items, fim)
    if (g >= 0 && isGrp(items[g])) fim = g
  } else return -1
  while (true) {
    const c = nextSig(items, fim)
    const t = c >= 0 ? nextSig(items, c) : -1
    if (c >= 0 && items[c].k === 'cast' && t >= 0 && (items[t].k === 'id' || items[t].k === 'raw')) {
      fim = t
      const g = nextSig(items, fim)
      if (g >= 0 && isGrp(items[g])) fim = g
    } else break
  }
  return fim
}

/**
 * Traduz o SQL do Postgres para o DuckDB do lake. `tabelas` são as fontes que
 * QUEM ESCREVE alcança — schema.tabela de outra fonte continua sem tradução e
 * cai na validação, que recusa com a explicação.
 */
export function traduzPostgres(sql: string, tabelas: CompatTable[]): CompatResult {
  const toks = tokenize(sql)
  const tree = toks ? toTree(toks) : null
  if (!tree) return { sql, applied: [] }
  const mapa = new Map<string, string[]>()
  for (const t of tabelas) {
    const chave = `${t.schema.toLowerCase()}.${t.table.toLowerCase()}`
    const lista = mapa.get(chave) ?? []
    if (!lista.includes(t.slug)) lista.push(t.slug)
    mapa.set(chave, lista)
  }
  const ctx: Ctx = { tabelas: mapa, applied: new Set() }
  const out = rewriteSeq(tree, ctx)
  if (!ctx.applied.size) return { sql, applied: [] }
  return { sql: render(out), applied: [...ctx.applied] }
}
