// ─────────────────────────────────────────────────────────────────────────
// Copiador dos METADADOS: Postgres → MariaDB (D-DSP-4), com conferência.
//
//   npm run meta:copy --workspace apps/api              copia e confere
//   npm run meta:copy --workspace apps/api -- --conferir   só confere
//
// No servidor (de dentro do container, que alcança os dois bancos):
//   docker exec datahub-api npx tsx apps/api/src/scripts/metaCopy.ts
//
// O que garante o "mínimo de impacto":
//  • O Postgres é lido numa transação REPEATABLE READ READ ONLY: uma foto
//    consistente de todas as tabelas no mesmo instante, e o banco recusa
//    qualquer escrita nela. Nada no Postgres muda, nem a sequência.
//  • O destino é o DB_DataHub, que só o datahub_app enxerga. O copiador só
//    recria tabelas que ELE criou antes (marca _copia_postgres) e só enquanto
//    a API não tiver começado a gravar lá — depois da virada ele se recusa.
//  • Antes de copiar, confere: mesmas migrations, mesmas colunas, e nenhum
//    texto maior que a coluna de destino. Na dúvida, para sem escrever nada.
//  • Depois, confere tabela por tabela: contagem e uma impressão digital do
//    conteúdo (hash de cada linha, somado), comparando o que voltou do MariaDB
//    com o que saiu do Postgres. Data/hora é copiada em texto UTC com
//    microssegundos — nada passa pelo Date do JavaScript.
// ─────────────────────────────────────────────────────────────────────────
import pg from 'pg'
import mysql from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { config, mariaFaltando } from '../core/config.js'
import { MariaPool, runMariaMigrations } from '../db/mariadb/client.js'
import { MIGRATIONS_DIR, MARIA_MIGRATIONS_DIR } from '../db/paths.js'

const SO_CONFERIR = process.argv.includes('--conferir')
const LOTE = 1_000
const MARCA = '_copia_postgres'

const log = (m: string) => console.log(m)
const falhar = (m: string): never => { console.error(`\nPAROU: ${m}`); process.exit(1) }

// ── Tipos das colunas no Postgres → como ler (texto sem perda) ───────────
type Tipo = 'tz' | 'date' | 'json' | 'array' | 'uuid' | 'vector' | 'bool' | 'num' | 'float' | 'int' | 'text'
interface Col { name: string; tipo: Tipo; varchar?: number }

function tipoPg(dataType: string, udt: string): Tipo {
  switch (dataType) {
    case 'timestamp with time zone': case 'timestamp without time zone': return 'tz'
    case 'date': return 'date'
    case 'jsonb': case 'json': return 'json'
    case 'ARRAY': return 'array'
    case 'uuid': return 'uuid'
    case 'boolean': return 'bool'
    case 'bigint': case 'numeric': return 'num'
    case 'double precision': case 'real': return 'float'
    case 'integer': case 'smallint': return 'int'
    case 'USER-DEFINED': return udt === 'vector' ? 'vector' : 'text'
    default: return 'text'
  }
}

const q = (c: string) => `"${c.replace(/"/g, '""')}"`
function lerPg(c: Col): string {
  switch (c.tipo) {
    case 'tz': return `to_char(${q(c.name)} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`
    case 'date': return `to_char(${q(c.name)}, 'YYYY-MM-DD')`
    case 'json': case 'uuid': case 'vector': case 'num': case 'float': return `${q(c.name)}::text`
    case 'array': return `to_json(${q(c.name)})::text`
    default: return q(c.name)
  }
}
function lerMaria(c: Col): string {
  switch (c.tipo) {
    case 'tz': return `DATE_FORMAT(${q(c.name)}, '%Y-%m-%d %H:%i:%s.%f')`
    case 'date': return `DATE_FORMAT(${q(c.name)}, '%Y-%m-%d')`
    case 'num': case 'float': case 'uuid': return `CAST(${q(c.name)} AS CHAR)`
    default: return q(c.name)
  }
}

/** Valor em forma canônica — igual dos dois lados quando o dado é o mesmo. */
function canon(v: unknown, c: Col): string {
  if (v === null || v === undefined) return '∅'
  switch (c.tipo) {
    case 'bool': return typeof v === 'boolean' ? String(v) : String(Number(v) !== 0)
    case 'float': return String(Number(v))
    case 'num': return /^-?\d+$/.test(String(v)) ? String(BigInt(String(v))) : String(Number(v))
    case 'int': return String(Number(v))
    case 'json': case 'array': return JSON.stringify(ordenaChaves(JSON.parse(String(v))))
    default: return Buffer.isBuffer(v) ? v.toString('utf8') : String(v)
  }
}
function ordenaChaves(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(ordenaChaves)
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, ordenaChaves((x as Record<string, unknown>)[k])]))
  return x
}

/** Impressão digital de uma tabela: soma (mod 2^64) do hash de cada linha — não depende da ordem. */
class Digital {
  linhas = 0
  soma = 0n
  add(row: Record<string, unknown>, cols: Col[]): void {
    const h = createHash('sha256').update(cols.map((c) => canon(row[c.name], c)).join('\u0001')).digest()
    this.soma = (this.soma + h.readBigUInt64BE(0)) & 0xffffffffffffffffn
    this.linhas++
  }
}

function escMaria(v: unknown, c: Col): string {
  if (v === null || v === undefined) return 'NULL'
  if (c.tipo === 'bool') return v ? 'TRUE' : 'FALSE'
  if (c.tipo === 'int' && typeof v === 'number') return String(v)
  return mysql.escape(String(v))
}

async function main(): Promise<void> {
  const pgCfg = config.datahubPg
  const myCfg = config.datahubMaria
  log(`origem : postgres ${pgCfg.host}:${pgCfg.port}/${pgCfg.database}`)
  log(`destino: mariadb  ${myCfg.host}:${myCfg.port}/${myCfg.database} (usuário ${myCfg.user})`)
  log(`modo   : ${SO_CONFERIR ? 'só conferir' : 'copiar e conferir'}\n`)
  const faltando = mariaFaltando()
  if (faltando.length || !myCfg.host || !myCfg.password) {
    falhar(`variável vazia no container: ${(faltando.length ? faltando : ['DATAHUB_MARIA_HOST/PASSWORD']).join(', ')}. ` +
      'Preencha na stack do Portainer e clique em "Update the stack" (salvar não recria o container).')
  }

  const src = new pg.Client({ ...pgCfg, application_name: 'datahub-meta-copy' })
  await src.connect()
  // Foto consistente e somente leitura: o Postgres recusa escrita nesta transação.
  await src.query('begin isolation level repeatable read read only')

  const tabelas = (await src.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'schema_migrations'
      order by table_name`)).rows.map((r) => String(r.table_name))
  const pgMigs = new Set((await src.query('select name from schema_migrations')).rows.map((r) => String(r.name)))

  const maria = new MariaPool(myCfg, { max: 2 })
  const dst = await mysql.createConnection({ ...myCfg, charset: 'UTF8MB4_GENERAL_CI', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  for (const s of [
    "SET SESSION sql_mode = 'PIPES_AS_CONCAT,ANSI_QUOTES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
    "SET SESSION time_zone = '+00:00'",
    'SET NAMES utf8mb4 COLLATE utf8mb4_nopad_bin',
  ]) await dst.query(s)

  const existentes = new Set(((await dst.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`))[0] as Array<{ t: string }>).map((r) => r.t))

  // ── 1. Destino: recriar só o que é nosso, e só antes da virada ─────────
  if (!SO_CONFERIR) {
    if (existentes.size) {
      if (!existentes.has(MARCA)) {
        falhar(`o banco ${myCfg.database} já tem ${existentes.size} tabela(s) que não vieram deste copiador. ` +
          'Não apago o que não criei — confira o que é e esvazie o banco à mão antes de copiar.')
      }
      const marca = ((await dst.query(`SELECT copiado_em FROM ${MARCA} ORDER BY copiado_em DESC LIMIT 1`))[0] as Array<{ copiado_em: string }>)[0]
      if (marca && existentes.has('audit_logs')) {
        const depois = ((await dst.query(
          `SELECT COUNT(*) AS n FROM audit_logs WHERE created_at > ?`, [marca.copiado_em]))[0] as Array<{ n: string }>)[0]
        if (Number(depois.n) > 0) {
          falhar(`a API já gravou no MariaDB depois da última cópia (${depois.n} registro(s) de auditoria após ${marca.copiado_em}). ` +
            'Ele virou o banco em uso: recopiar apagaria o que foi feito desde a virada.')
        }
      }
      log(`recriando a cópia anterior (${marca?.copiado_em ?? 'sem data'})…`)
      await dst.query('SET FOREIGN_KEY_CHECKS = 0')
      for (const t of existentes) await dst.query(`DROP TABLE IF EXISTS ${q(t)}`)
      await dst.query('SET FOREIGN_KEY_CHECKS = 1')
    }
    await runMariaMigrations(maria, MIGRATIONS_DIR, MARIA_MIGRATIONS_DIR, { skipSeed: true, log: () => {} })
    await dst.query(`CREATE TABLE ${MARCA} (copiado_em DATETIME(6) NOT NULL, origem VARCHAR(500) NOT NULL, linhas JSON NOT NULL)
      ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin`)
  } else if (!existentes.has('schema_migrations')) {
    falhar(`o banco ${myCfg.database} está vazio — não há o que conferir.`)
  }

  // ── 2. Pré-voo: mesmas migrations, mesmas colunas, texto que cabe ─────
  const myMigs = new Set(((await dst.query('SELECT name FROM schema_migrations'))[0] as Array<{ name: string }>).map((r) => r.name))
  const faltam = [...pgMigs].filter((m) => !myMigs.has(m))
  if (faltam.length) falhar(`migrations aplicadas no Postgres sem equivalente no MariaDB: ${faltam.join(', ')}`)

  const plano: Array<{ t: string; cols: Col[] }> = []
  const problemas: string[] = []
  for (const t of tabelas) {
    const pgCols = (await src.query(
      `select column_name, data_type, udt_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t])).rows
    const myCols = new Map(((await dst.query(
      `SELECT COLUMN_NAME AS c, DATA_TYPE AS ty, CHARACTER_MAXIMUM_LENGTH AS len, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [t]))[0] as
      Array<{ c: string; ty: string; len: string | null; extra: string }>)
      .filter((r) => !/INVISIBLE/i.test(r.extra)).map((r) => [r.c, r]))
    if (!myCols.size) { problemas.push(`tabela ${t} não existe no MariaDB`); continue }
    const cols: Col[] = pgCols.map((r) => {
      const my = myCols.get(String(r.column_name))
      const tipo = tipoPg(String(r.data_type), String(r.udt_name))
      return { name: String(r.column_name), tipo, varchar: my && my.ty === 'varchar' && my.len ? Number(my.len) : undefined }
    })
    for (const c of cols) if (!myCols.has(c.name)) problemas.push(`${t}.${c.name} existe no Postgres e não no MariaDB`)
    for (const c of myCols.keys()) if (!cols.some((x) => x.name === c)) problemas.push(`${t}.${c} existe no MariaDB e não no Postgres`)
    // texto maior que a coluna VARCHAR de destino (o MariaDB recusaria no meio da cópia)
    const limitadas = cols.filter((c) => c.varchar && c.tipo === 'text')
    if (limitadas.length) {
      const r = (await src.query(`select ${limitadas.map((c, i) => `max(char_length(${q(c.name)})) as m${i}`).join(', ')} from ${q(t)}`)).rows[0]
      limitadas.forEach((c, i) => {
        const m = Number(r[`m${i}`] ?? 0)
        if (m > c.varchar!) problemas.push(`${t}.${c.name}: há texto com ${m} caracteres; a coluna no MariaDB aceita ${c.varchar}`)
      })
    }
    plano.push({ t, cols })
  }
  if (problemas.length) falhar(`o esquema não bate — nada foi copiado:\n  - ${problemas.join('\n  - ')}`)
  log(`pré-voo ok: ${plano.length} tabelas, ${pgMigs.size} migrations, colunas e tamanhos conferidos.\n`)

  // ── 3. Cópia ──────────────────────────────────────────────────────────
  const contagens: Record<string, number> = {}
  if (!SO_CONFERIR) {
    await dst.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const { t, cols } of plano) {
      const ini = Date.now()
      const lista = cols.map((c) => q(c.name)).join(', ')
      // alias c0, c1…: duas expressões iguais (to_char, to_char) teriam o mesmo nome
      await src.query(`declare c_${t} no scroll cursor for select ${cols.map((c, i) => `${lerPg(c)} as c${i}`).join(', ')} from ${q(t)}`)
      let n = 0
      await dst.query('BEGIN')
      // INSERT de várias linhas, cortado por tamanho: linha grande (snapshot da
      // lixeira, conversa da IA) não pode estourar o max_allowed_packet.
      let buf: string[] = []
      let bytes = 0
      const descarrega = async () => {
        if (!buf.length) return
        await dst.query(`INSERT INTO ${q(t)} (${lista}) VALUES ${buf.join(', ')}`)
        buf = []
        bytes = 0
      }
      for (;;) {
        const { rows } = await src.query(`fetch ${LOTE} from c_${t}`)
        if (!rows.length) break
        for (const r of rows) {
          const tupla = `(${cols.map((c, i) => escMaria(r[`c${i}`], c)).join(', ')})`
          if (bytes + tupla.length > 4_000_000) await descarrega()
          buf.push(tupla)
          bytes += tupla.length
        }
        n += rows.length
      }
      await descarrega()
      await dst.query('COMMIT')
      await src.query(`close c_${t}`)
      contagens[t] = n
      log(`  copiada ${t.padEnd(24)} ${String(n).padStart(9)} linhas  ${((Date.now() - ini) / 1000).toFixed(1)}s`)
    }
    await dst.query('SET FOREIGN_KEY_CHECKS = 1')
  }

  // ── 4. Conferência ────────────────────────────────────────────────────
  log('\nconferindo (contagem + impressão digital do conteúdo)…')
  let divergentes = 0
  for (const { t, cols } of plano) {
    const a = new Digital()
    const b = new Digital()
    await src.query(`declare v_${t} no scroll cursor for select ${cols.map((c, i) => `${lerPg(c)} as c${i}`).join(', ')} from ${q(t)}`)
    for (;;) {
      const { rows } = await src.query(`fetch ${LOTE * 5} from v_${t}`)
      if (!rows.length) break
      for (const r of rows) a.add(Object.fromEntries(cols.map((c, i) => [c.name, r[`c${i}`]])), cols)
    }
    await src.query(`close v_${t}`)
    const stream = (dst as unknown as { connection: { query: (o: object) => { stream: () => AsyncIterable<Record<string, unknown>> } } })
      .connection.query({ sql: `SELECT ${cols.map((c, i) => `${lerMaria(c)} AS c${i}`).join(', ')} FROM ${q(t)}` }).stream()
    for await (const r of stream) b.add(Object.fromEntries(cols.map((c, i) => [c.name, r[`c${i}`]])), cols)
    const ok = a.linhas === b.linhas && a.soma === b.soma
    if (!ok) divergentes++
    log(`  ${ok ? 'ok  ' : 'DIFERENTE'} ${t.padEnd(24)} postgres ${String(a.linhas).padStart(9)} · mariadb ${String(b.linhas).padStart(9)}${ok ? '' : `  (impressões ${a.soma.toString(16)} × ${b.soma.toString(16)})`}`)
  }

  // ── 5. Leitura PELO APP: o mesmo objeto JavaScript dos dois lados ─────
  // A conferência acima prova que o dado é o mesmo. Esta prova que a API vai
  // VER o mesmo: lê uma amostra (até 2.000 linhas por tabela) pelo driver do
  // Postgres, como o app lê hoje, e pelo cliente MariaDB do app (tradutor +
  // conversão de tipos), e compara objeto por objeto — tipo incluído.
  // O lado Postgres lê DENTRO da mesma foto (o `src` ainda está na transação e
  // usa os tipos padrão do driver, como a API): com a API no ar, ler fora dela
  // pegava last_sync_at já atualizado depois da cópia e acusava diferença
  // que não era do cliente (ensaio de 12/11 no servidor).
  log('\nlendo pelo app (amostra por tabela, tipo a tipo)…')
  const pgApp = src
  const tipoJs = (v: unknown): string => {
    if (v === null || v === undefined) return 'null'
    if (v instanceof Date) return `date:${v.toISOString()}`
    if (Buffer.isBuffer(v)) return `buf:${v.toString('base64')}`
    if (Array.isArray(v)) return `[${v.map(tipoJs).join(',')}]`
    if (typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${k}:${tipoJs((v as Record<string, unknown>)[k])}`).join(',')}}`
    return `${typeof v}:${String(v)}`
  }
  let diferencasApp = 0
  for (const { t, cols } of plano) {
    const pk = ((await dst.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, [t]))[0] as Array<{ c: string }>).map((r) => r.c)
    if (!pk.length) continue
    const a = (await pgApp.query(`select * from ${q(t)} order by ${pk.map(q).join(', ')} limit 2000`)).rows
    if (!a.length) continue
    // chave como texto (data pura vai como AAAA-MM-DD, não como Date)
    const chave = (r: Record<string, unknown>) => pk.map((c) => {
      const v = r[c]
      const col = cols.find((x) => x.name === c)
      if (v instanceof Date && col?.tipo === 'date') return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
      return v
    })
    const b = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < a.length; i += 200) {
      const parte = a.slice(i, i + 200)
      const params: unknown[] = []
      const where = parte.map((r) => {
        const k = chave(r)
        return `(${pk.map((c, j) => { params.push(k[j]); return `${q(c)} = $${params.length}` }).join(' and ')})`
      }).join(' or ')
      for (const r of (await maria.query(`select * from ${q(t)} where ${where}`, params)).rows) b.set(JSON.stringify(chave(r)), r)
    }
    let difs = 0
    let exemplo = ''
    for (const r of a) {
      const m = b.get(JSON.stringify(chave(r)))
      const ka = tipoJs(r)
      const kb = m ? tipoJs(m) : 'AUSENTE'
      if (ka !== kb) {
        difs++
        if (!exemplo) {
          const col = Object.keys(r).find((k) => !m || tipoJs(r[k]) !== tipoJs(m[k]))
          exemplo = m ? `${col}: postgres ${tipoJs(r[col!]).slice(0, 80)} × mariadb ${tipoJs(m[col!]).slice(0, 80)}` : 'linha ausente'
        }
      }
    }
    if (difs) { diferencasApp++; log(`  DIFERENTE ${t.padEnd(24)} ${difs} de ${a.length} linhas — ${exemplo}`) }
    else log(`  ok   ${t.padEnd(24)} ${a.length} linhas iguais pelo app`)
  }
  await src.query('rollback') // só leitura: nada a confirmar no Postgres
  await src.end()

  if (!SO_CONFERIR) {
    await dst.query(`INSERT INTO ${MARCA} (copiado_em, origem, linhas) VALUES (UTC_TIMESTAMP(6), ?, ?)`,
      [`${pgCfg.host}:${pgCfg.port}/${pgCfg.database}`, JSON.stringify(contagens)])
  }
  await dst.end()
  await maria.end()

  if (divergentes) falhar(`${divergentes} tabela(s) com conteúdo diferente. Não vire o banco com esta cópia.`)
  if (diferencasApp) falhar(`${diferencasApp} tabela(s) que o app leria diferente. Não vire o banco antes de corrigir o cliente MariaDB.`)
  log(`\nTUDO CONFERE: ${plano.length} tabelas idênticas nos dois bancos, e o app lê o mesmo dos dois lados.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
