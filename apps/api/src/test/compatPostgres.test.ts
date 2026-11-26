// ─────────────────────────────────────────────────────────────────────────
// SQL do Postgres no Data Hub (pedido de 26/11/2026): a consulta copiada do
// Voalle tem de rodar e dar o MESMO resultado. Dois gabaritos:
//   • o Postgres de laboratório (schema `fonte`): a mesma consulta roda lá e
//     aqui, e as linhas têm de ser iguais — vale para o que não depende de
//     idioma;
//   • a saída do próprio Voalle (lc_numeric/lc_time pt_BR), fixada abaixo:
//     milhar com ponto, vírgula decimal, R$, nomes de mês com TM, initcap com
//     acento. Conferida em 26/11/2026.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  as, db, shutdown, connectTestSource, fonteDb, publishSource, syncAndWait, waitFor, lakeCount, USERS,
} from './harness.js'
import { traduzPostgres } from '../modules/transform/pgCompat.js'

let conn = ''

before(async () => {
  conn = await connectTestSource()
  await fonteDb.query(`create table fonte.pg_compat (
      id int primary key, nome text, criado timestamp, valor numeric(12,2), payload text, cidade text)`)
  await fonteDb.query(`insert into fonte.pg_compat values
      (1, 'JOÃO da silva', '2026-03-05 07:08:09', 1234.50, '{"tags":["a","b"],"n":{"x":5}}', 'São Leopoldo'),
      (2, 'maria-clara souza', '2026-11-26 18:30:00', -42.10, '{"tags":["c"],"n":{"x":7}}', 'Porto Alegre'),
      (3, null, null, null, null, null)`)
  const ds = await publishSource(conn, 'pg_compat', { syncMode: 'snapshot' })
  await syncAndWait(ds.id)
})

after(shutdown)

async function previa(sql: string, quem: 'admin' | 'editor' = 'admin'): Promise<{ status: number; body: any }> {
  const r = await as(quem).post('/api/v1/datasets/derived/preview', { sql })
  return { status: r.status, body: r.body }
}

// Valor comparável entre os dois bancos: número como número, o resto como texto.
function norm(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Math.round(v * 1e9) / 1e9
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1e9) / 1e9
  return String(v)
}

/** Roda a MESMA consulta no Postgres e no Data Hub; as linhas têm de bater. */
async function igual(sql: string) {
  const pg = await fonteDb.query(sql)
  const colunas = pg.fields.map((f) => f.name)
  const esperado = pg.rows.map((r) => colunas.map((c) => norm(r[c])))
  const dh = await previa(sql)
  assert.equal(dh.status, 200, `${sql}\n→ ${JSON.stringify(dh.body)}`)
  const veio = (dh.body.rows as Record<string, unknown>[]).map((r) => colunas.map((c) => norm(r[c])))
  assert.deepEqual(veio, esperado, sql)
}

describe('A consulta do Postgres roda igual no lake', () => {
  it('schema.tabela da fonte e to_char de data', () => igual(
    `select id, to_char(criado, 'DD/MM/YYYY HH24:MI') as d, to_char(criado, 'YYYY-MM') as m,
            to_char(criado, 'FMDD/FMMM/YY') as f, to_char(criado, 'Dy, DD Mon YYYY') as n,
            to_char(criado, 'HH12:MI AM') as h, to_char(criado, 'Q"º tri" IW') as q
       from fonte.pg_compat order by id`))

  it('~ e ~* procuram em qualquer parte do texto, como no Postgres', () => igual(
    `select id, nome ~* 'SILVA' as a, nome ~ 'silva' as b, nome !~ '^maria' as c, lower(cidade) ~ 'leo' as d,
            nome::text ~ 'a.*a' as e
       from fonte.pg_compat order by id`))

  it('to_char de número com separador literal', () => igual(
    `select id, to_char(valor, 'FM999,999.00') as v, to_char(valor, '999,999.00') as w, to_char(valor, 'FM9999.99') as x
       from fonte.pg_compat order by id`))

  it('jsonb: ->, ->>, extract_path_text e array_elements_text', async () => {
    await igual(`select id, payload::jsonb -> 'n' ->> 'x' as x, jsonb_extract_path_text(payload::jsonb, 'n', 'x') as y
                   from fonte.pg_compat order by id`)
    await igual(`select p.id, t.tag from fonte.pg_compat p, jsonb_array_elements_text(p.payload::jsonb -> 'tags') as t(tag)
                  order by p.id, t.tag`)
  })

  it('format com %s (NULL vira vazio), div, any(\'{…}\'), LIKE com barra, numeric sem precisão', async () => {
    // O lake guarda número como DOUBLE: sem a tradução, o id 1 viraria "1.0".
    await igual(`select id, format('%s-%s', id, cidade) as f, div(id * 7, 2) as d, id::text as t,
                        cast(id as varchar) as v, concat(id, '/', cidade) as c, concat_ws('-', id, nome) as w
                   from fonte.pg_compat order by id`)
    await igual(`select id from fonte.pg_compat where id = any('{1,3}') order by id`)
    await igual(`select id from fonte.pg_compat where 'a_b' like 'a\\_b' and 'axb' not like 'a\\_b' order by id`)
    await igual(`select 1.23456789::numeric as n, cast(2.5 as numeric) * 2 as m`)
  })

  it('to_date, to_timestamp e regexp_split_to_table', async () => {
    await igual(`select id, to_date('05/03/2026', 'DD/MM/YYYY') = criado::date as dia,
                        to_timestamp('05/03/2026 07:08:09', 'DD/MM/YYYY HH24:MI:SS') = criado as hora
                   from fonte.pg_compat where id = 1`)
    await igual(`select regexp_split_to_table('a,b,c', ',') as p order by p`)
  })

  it('um calculado salvo com SQL do Postgres materializa', async () => {
    const r = await as('admin').post('/api/v1/datasets/derived', {
      name: 'TESTE-COMITE Clientes por mês (SQL do Postgres)',
      sql: `select to_char(criado, 'YYYY-MM') as mes, count(*) as n from fonte.pg_compat
             where nome ~* 'a' group by 1 order by 1`,
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const pronto = await waitFor(async () => (await lakeCount(r.body.slug).catch(() => 0)) === 2, 30_000)
    assert.ok(pronto, 'o calculado não materializou as 2 linhas')
  })
})

describe('Saída igual à do Voalle (pt_BR)', () => {
  // Gabarito: select to_char(timestamp '2026-03-05 07:08:09.123456', <molde>) no Voalle.
  const DATAS: Record<string, string> = {
    'DD/MM/YYYY HH24:MI:SS': '05/03/2026 07:08:09', 'YYYY-MM-DD HH24:MI:SS.MS': '2026-03-05 07:08:09.123',
    'YYYY-MM-DD"T"HH24:MI:SS.US': '2026-03-05T07:08:09.123456', 'HH:MI pm': '07:08 am', 'Mon/YYYY': 'Mar/2026',
    'MON': 'MAR', 'Month': 'March    ', 'FMMonth': 'March', 'Day': 'Thursday ', 'DY': 'THU', 'D': '5', 'ID': '4',
    'DDD': '064', 'WW': '10', 'FMDD/FMMM/YYYY': '5/3/2026', 'FMHH24h': '7h', 'TMMonth': 'Março', 'TMMon': 'Mar',
    'TMMONTH': 'MARÇO', 'TMmonth': 'março', 'TMDay': 'Quinta', 'TMDy': 'Qui', 'FMTMMonth': 'T03onth',
    'TMMonth/YYYY': 'Março/2026', '"Semana" IW': 'Semana 10', 'YYYY "de" Month': '2026 de March    ', 'J': '2461105',
    'CC': '21', 'SSSS': '25689', 'DD"º"': '05º',
  }
  // Gabarito: select to_char(<valor>::numeric, <molde>) no Voalle.
  const NUMEROS: [string, string, string][] = [
    ['1234.5', 'FM999G999D00', '1.234,50'], ['1234.5', '999G999D00', '   1.234,50'], ['1234.5', '9999.99', ' 1234.50'],
    ['1234.5', 'FM9999.99', '1234.5'], ['-1234.5', 'FM999G999D00', '-1.234,50'], ['-1234.5', '999G999D00', '  -1.234,50'],
    ['5', '000', ' 005'], ['5', 'FM000', '005'], ['5', '999', '   5'], ['0.5', 'FM990D00', '0,50'], ['0.5', 'FM9D99', ',5'],
    ['1234567.891', 'FM999G999G999D00', '1.234.567,89'], ['12', 'FM99%', '12%'], ['1234.5', 'L999G999D00', 'R$   1.234,50'],
    ['42', 'FM9999', '42'], ['1234.567', 'FM9999D9', '1234,6'], ['99999', '999', ' ###'], ['0', 'FM999', '0'], ['0', '999', '   0'],
  ]

  it('to_char de data, com nomes em português no TM', async () => {
    const moldes = Object.keys(DATAS)
    const sql = `select ${moldes.map((m, i) =>
      `to_char(timestamp '2026-03-05 07:08:09.123456', '${m}') as c${i}`).join(', ')}`
    const r = await previa(sql)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    moldes.forEach((m, i) => assert.equal(r.body.rows[0][`c${i}`], DATAS[m], `molde ${m}`))
  })

  it('to_char de número: milhar com ponto, vírgula decimal, R$, FM e estouro', async () => {
    const sql = `select ${NUMEROS.map(([v, m], i) => `to_char(${v}::numeric, '${m}') as c${i}`).join(', ')}`
    const r = await previa(sql)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    NUMEROS.forEach(([v, m, esp], i) => assert.equal(r.body.rows[0][`c${i}`], esp, `${v} com ${m}`))
  })

  it('to_number, initcap com acento e unaccent', async () => {
    const r = await previa(`select to_number('1.234,50', '9G999D99')::text as a, to_number('R$ 1.234,50', 'L9G999D99')::text as b,
      initcap('JOÃO da silva-souza d''ávila 2ºandar') as c, unaccent('Ação São') as d`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.rows[0], { a: '1234.50', b: '1234.50', c: "João Da Silva-Souza D'Ávila 2ºandar", d: 'Acao Sao' })
  })
})

describe('O que não tem tradução fiel diz por quê', () => {
  it('molde que não é texto fixo, fuso (TZ) e ordinal (th) recusam com a explicação', async () => {
    const casos: [string, RegExp][] = [
      [`select to_char(criado, cidade) from fonte.pg_compat`, /texto fixo/],
      [`select to_char(criado, 'HH24 TZ') from fonte.pg_compat`, /"TZ"/],
      [`select to_char(3, 'FM9th')`, /"th"/],
      [`select format('%I', 'x')`, /%I/],
    ]
    for (const [sql, msg] of casos) {
      const r = await previa(sql)
      assert.equal(r.status, 400, sql)
      assert.match(r.body.error, msg, sql)
    }
  })

  it('schema.tabela fora do lake explica o que fazer', async () => {
    const r = await previa('select * from erp.nao_existe')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /não está no lake como fonte/)
  })

  it('SQL do DuckDB passa intacto', () => {
    const duck = `select format('{}-{}', 1, 2) as a, regexp_matches(nome, 'a') as b, 7 // 2 as c,
                         list_transform([1, 2], lambda x: x + 1) as d, x::decimal(10, 2) from t`
    const r = traduzPostgres(duck, [{ schema: 'erp', table: 'contracts', slug: 'contracts' }])
    assert.equal(r.sql, duck)
    assert.deepEqual(r.applied, [])
  })

  it('a função que falta no motor diz que falta, e não "erro de catálogo"', async () => {
    const r = await previa(`select justify_interval(interval '36 hours') as j`)
    assert.equal(r.status, 400)
    assert.match(r.body.error, /não existe no motor do lake/)
  })
})

describe('Quem não alcança a fonte não a alcança pelo schema', () => {
  it('fonte privada de outra pessoa: fonte.tabela não vira atalho para o dado', async () => {
    await fonteDb.query(`create table fonte.pg_privada as select 1 as id, 'SEGREDO-PG' as nome`)
    const ds = await publishSource(conn, 'pg_privada', { syncMode: 'snapshot' })
    await syncAndWait(ds.id)
    await db.query(`update datasets set visibility = 'private', owner_email = $2 where id = $1`, [ds.id, USERS.editor2])
    const r = await previa('select nome from fonte.pg_privada', 'editor')
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /não tem acesso|não está no lake/)
    assert.ok(!JSON.stringify(r.body).includes('SEGREDO-PG'))
  })
})
