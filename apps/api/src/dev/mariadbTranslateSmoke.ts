// Smoke do tradutor Postgres → MariaDB (sem banco). Cada caso é uma construção
// que existe nas consultas do Data Hub; o texto esperado é o que o MariaDB
// 10.11 executa. Rodar: npm run mariadb:smoke --workspace apps/api
import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate, splitStatements, type Seg, type TranslateOpts, UnsupportedSqlError } from '../db/mariadb/translate.js'

const opts: TranslateOpts = {
  pk: (t) => ({ datasets: ['id'], teams: ['id'], health_checks: ['id'], usage_daily: ['tenant_id', 'day'] } as Record<string, string[]>)[t],
  notNull: (c) => ['id', 'created_at', 'started_at', 'name', 'slug', 'sort_order'].includes(c),
}

let falhas = 0
function check(nome: string, ok: boolean, detalhe = ''): void {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}${ok || !detalhe ? '' : `\n      ${detalhe}`}`)
  if (!ok) falhas++
}
const show = (segs: Seg[]) => segs.map((s) => (typeof s === 'string' ? s : 'ids' in s ? '<IDS>' : `<${s.kind}${s.neg ? '!' : ''}:${s.p}>`)).join('')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
function igual(nome: string, sql: string, esperado: string): void {
  const got = norm(show(translate(sql, opts).segs))
  check(nome, got === norm(esperado), `esperado: ${norm(esperado)}\n      obtido:   ${got}`)
}
function recusa(nome: string, sql: string, trecho: string): void {
  try {
    translate(sql, opts)
    check(nome, false, 'deveria recusar')
  } catch (e) {
    check(nome, e instanceof UnsupportedSqlError && e.message.includes(trecho), (e as Error).message)
  }
}

// ── parâmetros, casts ────────────────────────────────────────────────────
igual('placeholders e reuso', 'select * from datasets where tenant_id = $1 and (owner_email = $2 or $2 is null)',
  'select * from datasets where tenant_id = <value:0> and (owner_email = <value:1> or <value:1> is null)')
igual('cast de parâmetro some e marca o tipo', 'update datasets set source_config = $2::jsonb where id = $1::uuid',
  'update datasets set source_config = <json:1> where id = <value:0>')
igual('cast de coluna vira CAST', 'select count(*)::int as n from datasets',
  'select CAST(count(*) AS SIGNED) as "n" from datasets')
igual('cast de data', 'select created_at::date as d from datasets where created_at > $1::timestamptz',
  'select CAST(created_at AS DATE) as "d" from datasets where created_at > CAST(<datetime:0> AS DATETIME(6))')
igual('cast numérico dentro de função', 'select round(avg(x)::numeric, 2) as m from t',
  'select round(CAST(avg(x) AS DECIMAL(65,30)), 2) as "m" from t')

// ── any / all ────────────────────────────────────────────────────────────
igual('= any($1::uuid[]) vira IN lista', 'select id from datasets where id = any($1::uuid[])',
  'select id from datasets where id IN <list:0>')
igual('<> all($2) vira NOT IN', 'delete from dataset_fields where dataset_id = $1 and key <> all($2::text[])',
  'delete from dataset_fields where dataset_id = <value:0> and "key" NOT IN <list!:1>')
igual('valor = any(coluna array)', 'select 1 from api_credentials c where $2 = any(c.dataset_slugs)',
  'select 1 AS "?column?" from api_credentials c where JSON_CONTAINS(c.dataset_slugs, JSON_QUOTE(<value:1>))')

// ── ilike, intervalos ────────────────────────────────────────────────────
igual('ilike com concatenação', `select id from datasets where name ilike '%' || $1 || '%'`,
  `select id from datasets where LOWER(name) LIKE LOWER('%' || <value:0> || '%')`)
igual('interval literal', `select 1 from sync_runs r where r.started_at > now() - interval '24 hours'`,
  'select 1 AS "?column?" from sync_runs r where r.started_at > NOW(6) - INTERVAL 24 HOUR')
igual('make_interval', 'select 1 from h where last_run_at < now() - make_interval(mins => interval_minutes)',
  'select 1 AS "?column?" from h where last_run_at < NOW(6) - INTERVAL (interval_minutes) MINUTE')
igual('make_interval com parâmetro', 'delete from trash_items where deleted_at < now() - make_interval(days => $1)',
  'delete from trash_items where deleted_at < NOW(6) - INTERVAL (<value:0>) DAY')

// ── funções ──────────────────────────────────────────────────────────────
igual('json_agg/json_build_object', `select (select coalesce(json_agg(json_build_object('key', f.key, 'type', f.type)), '[]') from dataset_fields f) as fields from datasets d`,
  `select (select coalesce(JSON_ARRAYAGG(JSON_OBJECT('key', f."key", 'type', f.type)), '[]') from dataset_fields f) as "fields" from datasets d`)
igual('string_agg com order by', `select string_agg(r.name, ',' order by r.name) as roles from roles r`,
  `select GROUP_CONCAT(r.name order by r.name SEPARATOR ',') as "roles" from roles r`)
igual('count filter', 'select count(*) filter (where status = $1) as n from t',
  `select count(CASE WHEN status = <value:0> THEN 1 END) as "n" from t`)
igual('bool_or', 'select bool_or(d.owner_email = $2) as owner from d',
  'select MAX(d.owner_email = <value:1>) as "owner" from d')
igual('nome que o Postgres daria', 'select count(*), max(created_at) from datasets',
  'select count(*) AS "count", max(created_at) AS "max" from datasets')

// ── on conflict ──────────────────────────────────────────────────────────
igual('on conflict do update', `insert into users (email, name) values ($1, $2)
  on conflict (email) do update set name = excluded.name, updated_at = now() returning id`,
  'insert into users (email, name) values (<value:0>, <value:1>) ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = NOW(6) returning id')
igual('on conflict com alvo parcial', `insert into dashboard_grants (dashboard_id, team_id, level) values ($1, $2, $3)
  on conflict (dashboard_id, team_id) where team_id is not null do update set level = excluded.level`,
  'insert into dashboard_grants (dashboard_id, team_id, level) values (<value:0>, <value:1>, <value:2>) ON DUPLICATE KEY UPDATE level = VALUES(level)')
{
  const t = translate('insert into team_members (team_id, user_email) values ($1, $2) on conflict do nothing', opts)
  check('on conflict do nothing vira insert com duplicata tolerada', t.kind === 'insert-do-nothing'
    && norm(show(t.segs)) === 'insert into team_members (team_id, user_email) values (<value:0>, <value:1>)', norm(show(t.segs)))
}

// ── ordenação de NULL ────────────────────────────────────────────────────
igual('desc em coluna que aceita NULL ganha chave', 'select * from datasets order by last_sync_at desc limit $1',
  'select * from datasets order by (last_sync_at IS NULL) DESC, last_sync_at DESC limit <int:0>')
igual('coluna NOT NULL não ganha chave', 'select * from sync_runs order by started_at desc',
  'select * from sync_runs order by started_at DESC')
igual('asc em coluna que aceita NULL', 'select * from t order by d.label, x.id',
  'select * from t order by (d.label IS NULL) ASC, d.label, x.id')
igual('nulls last explícito no desc', 'select * from r order by r.finished_at desc nulls last limit 15',
  'select * from r order by r.finished_at DESC limit 15')

// ── reservadas, limit, offset ────────────────────────────────────────────
igual('colunas reservadas', 'select key, sql, rows, r.trigger from t r',
  'select "key", "sql", "rows", r."trigger" from t r')
igual('offset sem limit', 'select * from t order by id offset $1',
  'select * from t order by id LIMIT 18446744073709551615 offset <int:0>')

// ── literais ─────────────────────────────────────────────────────────────
igual('barra em literal fica literal', String.raw`select * from t where a like 'x\y'`,
  String.raw`select * from t where a like 'x\\y'`)
igual('literal com ? e $1 dentro fica intacto', `select '$1 ? ''a''' as s from t where x = $1`,
  `select '$1 ? ''a''' as "s" from t where x = <value:0>`)

// ── tipos do resultado ───────────────────────────────────────────────────
{
  const h = translate(`select count(*)::int as n, exists(select 1) as e, d.id, coalesce(bool_or(g.x), false) as g,
    (select coalesce(json_agg(1), '[]')) as js, count(*) as c, case when x then true else false end as b from d`, opts).hints
  check('hints de tipo', JSON.stringify(h) === JSON.stringify({ b: 'bool', c: 'text', js: 'json', g: 'bool', e: 'bool', n: 'int' }), JSON.stringify(h))
}

// ── update … returning ───────────────────────────────────────────────────
{
  const t = translate('update teams set name = $2, updated_at = now() where id = $1 and tenant_id = (select id from tenants where slug = $3) returning slug', opts)
  check('update returning vira plano', t.kind === 'update-returning'
    && norm(show(t.upd!.lock)) === 'SELECT "id" FROM teams where id = <value:0> and tenant_id = (select id from tenants where slug = <value:2>) FOR UPDATE'
    && norm(show(t.upd!.update)) === 'update teams set name = <value:1>, updated_at = NOW(6) WHERE "id" IN <IDS>'
    && norm(show(t.upd!.select)) === 'SELECT slug FROM teams WHERE "id" IN <IDS>',
  [show(t.upd!.lock), show(t.upd!.update), show(t.upd!.select)].join('\n      '))
}
{
  const t = translate('update health_checks h set name = $3 where h.id = $2 returning h.id', opts)
  check('update returning com alias', norm(show(t.upd!.select)) === 'SELECT h.id FROM health_checks h WHERE h."id" IN <IDS>', show(t.upd!.select))
}

// ── parâmetro que vai para coluna de data/hora ───────────────────────────
{
  const o = { ...opts, datetimeCol: (c: string) => ['expires_at', 'last_sync_at'].includes(c) }
  const ins = show(translate('insert into api_credentials (tenant_id, name, expires_at) values ($1, $2, $3)', o).segs)
  const upd = show(translate('update datasets set last_sync_at = $2 where id = $1 and $3 < last_sync_at', o).segs)
  const sel = show(translate(`insert into datasets (tenant_id, last_sync_at) select t.id, $2 from tenants t where t.slug = $1`, o).segs)
  check('parâmetro de data/hora inferido pela coluna (insert, set, comparação, insert…select)',
    ins.includes('<dtsoft:2>') && !ins.includes('<dtsoft:1>') && upd.includes('<dtsoft:1>') && upd.includes('<dtsoft:2>')
    && !upd.includes('<dtsoft:0>') && sel.includes('<dtsoft:1>'), [ins, upd, sel].join('\n      '))
}

// ── recusas (reescrever à mão) ───────────────────────────────────────────
recusa('lateral', 'select * from a cross join lateral (select 1) x', 'lateral')
recusa('at time zone', `select (now() at time zone 'America/Sao_Paulo')::date`, 'at time zone')
recusa('array_agg', 'select array_agg(x) from t', 'array_agg')
igual('operador json ->>', `select i.snapshot->'dataset'->>'kind' as k from t i`,
  `select (CASE WHEN JSON_TYPE(JSON_EXTRACT(i.snapshot, '$."dataset"."kind"')) = 'NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(i.snapshot, '$."dataset"."kind"')) END) as "k" from t i`)
check('operador json -> devolve objeto', translate(`select x->'a' as o from t`, opts).hints.o === 'json')
recusa('operador #>>', `select x#>>'{a,b}' from t`, '#>>')
recusa('update from', 'update a set x = b.y from b where a.id = b.id returning a.id', 'update … from')
recusa('on conflict do update where', 'insert into t (a) values (1) on conflict (a) do update set b = 1 where t.c', 'where')

// ── transação ────────────────────────────────────────────────────────────
check('begin/commit passam direto', translate('begin', opts).kind === 'tx' && translate('commit', opts).segs[0] === 'COMMIT')

// ── divisão de migrations ────────────────────────────────────────────────
check('split respeita literal com ;', splitStatements(`create table a (x text default ';'); -- c;\ninsert into a values ('a;b');`).length === 2)

// ── paridade: toda migration do Postgres tem a versão MariaDB ───────────
{
  const here = dirname(fileURLToPath(import.meta.url))
  const pg = readdirSync(resolve(here, '../db/migrations')).filter((f) => f.endsWith('.sql'))
  const maria = new Set(readdirSync(resolve(here, '../db/migrations-mariadb')).filter((f) => f.endsWith('.sql')))
  const base = 43 // 000-base.sql cobre 001…043
  const faltam = pg.filter((f) => Number(f.slice(0, 3)) > base && !maria.has(f))
  check('toda migration nova do Postgres tem versão em migrations-mariadb/', !faltam.length, `faltam: ${faltam.join(', ')}`)
}

console.log(falhas ? `\n${falhas} falha(s).` : '\ntradutor ok.')
process.exit(falhas ? 1 : 0)
