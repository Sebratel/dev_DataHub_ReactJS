// O UPDATE da configuração de sincronização, contra um Postgres DE VERDADE.
//
// Existe por causa de uma falha que nenhum teste de tipos pegaria: o UPDATE
// mudava `sync_cadence` sem tocar em `schedule_id`, e a constraint
// `datasets_schedule_pairing_check` exige que os dois andem juntos
// (`sync_cadence = 'schedule'` ⟺ `schedule_id is not null`). Tirar um conjunto
// do agendamento nomeado produzia o par proibido — cadência 'hourly' com
// agendamento preenchido — e o Postgres recusava a linha.
//
// Em produção isso reprovou 100% de um lote de 44 conjuntos. E era invisível
// pela tela do conjunto, que evita reenviar a cadência justamente quando há
// agendamento; só a padronização em lote bate nesse caminho, porque o trabalho
// dela é mudar a cadência de quem já tem uma.
//
// Roda em pglite (Postgres embarcado): sem Docker, sem servidor, mas com o
// MESMO motor que recusou a gravação em produção — é o único jeito de provar
// que a correção funciona sem subir o ambiente inteiro.
//
// Uso: npm run sqlconfig:smoke --workspace apps/api
import { PGlite } from '@electric-sql/pglite'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const pg = new PGlite()

// Só o suficiente para exercitar a constraint — não é a migration inteira.
await pg.exec(`
  create table sync_schedules (
    id uuid primary key default gen_random_uuid(),
    name text not null
  );
  create table datasets (
    id uuid primary key default gen_random_uuid(),
    slug text not null,
    sync_mode text not null default 'live',
    incremental_key text,
    incremental_key_2 text,
    dedupe_keys text[] not null default '{}',
    watermark text,
    watermark_2 text,
    watermark_lag_minutes int not null default 0,
    sync_since text,
    sync_since_days int,
    sync_cadence text not null default 'daily',
    schedule_id uuid references sync_schedules(id) on delete set null,
    updated_at timestamptz not null default now(),
    constraint datasets_sync_cadence_check
      check (sync_cadence in ('daily', 'hourly', 'manual', 'cascade', 'schedule')),
    constraint datasets_schedule_pairing_check
      check ((sync_cadence = 'schedule') = (schedule_id is not null)),
    constraint datasets_key2_needs_dedupe
      check (incremental_key_2 is null or cardinality(dedupe_keys) > 0)
  );
`)

const sched = (await pg.query<{ id: string }>(
  `insert into sync_schedules (name) values ('1x ao dia') returning id`,
)).rows[0]

// O UPDATE exatamente como está em syncConfig.ts.
const UPDATE = `
  update datasets set
     sync_mode = $2, incremental_key = $3, incremental_key_2 = $4,
     sync_cadence = coalesce($5, sync_cadence),
     schedule_id = case when $5 is null then schedule_id else null end,
     sync_since = $6, sync_since_days = $7,
     dedupe_keys = $8, watermark_lag_minutes = $9,
     watermark   = case when $10 then null else watermark end,
     watermark_2 = case when $11 then null else watermark_2 end,
     updated_at = now()
   where id = $1 returning slug, sync_cadence, schedule_id`

async function novoConjunto(cadence: string, scheduleId: string | null): Promise<string> {
  return (await pg.query<{ id: string }>(
    `insert into datasets (slug, sync_mode, sync_cadence, schedule_id)
     values ('conj', 'snapshot', $1, $2) returning id`,
    [cadence, scheduleId],
  )).rows[0].id
}

type Linha = { slug: string; sync_cadence: string; schedule_id: string | null }
const aplicar = (id: string, cadencia: string | null) => pg.query<Linha>(UPDATE, [
  id, 'incremental', 'created_at', 'updated_at', cadencia,
  null, null, ['id'], 10, true, true,
])

console.log('\n── o caso que reprovou o lote em produção ──')

// Conjunto seguindo um agendamento nomeado, indo para cadência fixa.
{
  const id = await novoConjunto('schedule', sched.id)
  try {
    const r = (await aplicar(id, 'hourly')).rows[0]
    check('sair de agendamento nomeado para "de hora em hora" grava',
      r.sync_cadence === 'hourly' && r.schedule_id === null,
      `cadência=${r.sync_cadence} agendamento=${r.schedule_id ?? 'null'}`)
  } catch (e) {
    check('sair de agendamento nomeado para "de hora em hora" grava', false, (e as Error).message)
  }
}

// O mesmo para as outras duas cadências fixas.
for (const cadencia of ['daily', 'manual']) {
  const id = await novoConjunto('schedule', sched.id)
  try {
    const r = (await aplicar(id, cadencia)).rows[0]
    check(`sair de agendamento nomeado para "${cadencia}" grava`,
      r.sync_cadence === cadencia && r.schedule_id === null,
      `cadência=${r.sync_cadence} agendamento=${r.schedule_id ?? 'null'}`)
  } catch (e) {
    check(`sair de agendamento nomeado para "${cadencia}" grava`, false, (e as Error).message)
  }
}

console.log('\n── o que NÃO pode ter mudado junto ──')

// Cadência nula = "não mexa na cadência". O agendamento tem de sobreviver,
// senão a padronização com agendamento escolhido tiraria o conjunto dele
// justamente quando a intenção é mantê-lo.
{
  const id = await novoConjunto('schedule', sched.id)
  const r = (await aplicar(id, null)).rows[0]
  check('cadência nula preserva o agendamento',
    r.sync_cadence === 'schedule' && r.schedule_id === sched.id,
    `cadência=${r.sync_cadence} agendamento=${r.schedule_id ?? 'null'}`)
}

// Conjunto que nunca teve agendamento: nada a limpar, nada a quebrar.
{
  const id = await novoConjunto('daily', null)
  const r = (await aplicar(id, 'hourly')).rows[0]
  check('conjunto sem agendamento muda de cadência normalmente',
    r.sync_cadence === 'hourly' && r.schedule_id === null)
}

console.log('\n── a constraint continua valendo ──')

// A correção não pode ter afrouxado a regra: o par proibido segue proibido.
{
  const id = await novoConjunto('daily', null)
  try {
    await pg.query(`update datasets set schedule_id = $2 where id = $1`, [id, sched.id])
    check('cadência fixa COM agendamento continua sendo recusada', false, 'o banco aceitou o par proibido')
  } catch (e) {
    check('cadência fixa COM agendamento continua sendo recusada',
      (e as Error).message.includes('datasets_schedule_pairing_check'))
  }
}
{
  const id = await novoConjunto('daily', null)
  try {
    await pg.query(`update datasets set sync_cadence = 'schedule' where id = $1`, [id])
    check("cadência 'schedule' SEM agendamento continua sendo recusada", false, 'o banco aceitou o par proibido')
  } catch (e) {
    check("cadência 'schedule' SEM agendamento continua sendo recusada",
      (e as Error).message.includes('datasets_schedule_pairing_check'))
  }
}

// ── Execuções órfãs em 'running' ────────────────────────────────────────
// Um run só sai de 'running' se o código chegar ao fim. Processo morto no meio
// (deploy, OOM) deixa a linha pendurada para sempre: a tela do conjunto mostra
// "Sincronizando…" eternamente e a fila conta como "rodando agora" — foi o que
// produziu execuções com "1384h" de duração no painel.
console.log('\n── execuções órfãs fechadas no boot ──')
await pg.exec(`
  create table sync_runs (
    id uuid primary key default gen_random_uuid(),
    dataset_id uuid not null,
    mode text not null,
    status text not null default 'running',
    rows bigint not null default 0,
    error text,
    started_at timestamptz not null default now(),
    finished_at timestamptz
  );
  insert into sync_runs (dataset_id, mode, status, started_at) values
    (gen_random_uuid(), 'incremental', 'running', now() - interval '57 days'),
    (gen_random_uuid(), 'incremental', 'running', now() - interval '2 minutes');
  insert into sync_runs (dataset_id, mode, status, finished_at, rows) values
    (gen_random_uuid(), 'incremental', 'done', now(), 10);
  insert into sync_runs (dataset_id, mode, status, finished_at, error) values
    (gen_random_uuid(), 'snapshot', 'error', now(), 'erro original que nao pode ser sobrescrito');
`)

// A MESMA instrução de closeOrphanRuns.
const FECHAR = `update sync_runs set status = 'error', finished_at = now(),
        error = coalesce(error, 'Interrompida: o servidor reiniciou durante a execução ' ||
                                '(deploy, restart do container ou falta de memória). ' ||
                                'Os dados anteriores do conjunto continuam intactos.')
  where status = 'running'`

const fechadas = (await pg.query(FECHAR)).affectedRows ?? 0
check('fecha TODA execução pendurada, recente ou antiga', fechadas === 2, `fechou ${fechadas}`)

const aindaRodando = (await pg.query<{ n: number }>(
  `select count(*)::int as n from sync_runs where status = 'running'`)).rows[0].n
check('nenhuma sobra em running', aindaRodando === 0, `sobraram ${aindaRodando}`)

const concluida = (await pg.query<{ n: number }>(
  `select count(*)::int as n from sync_runs where status = 'done'`)).rows[0].n
check('execução concluída não é tocada', concluida === 1, `restaram ${concluida}`)

const original = (await pg.query<{ error: string }>(
  `select error from sync_runs where mode = 'snapshot'`)).rows[0].error
check('erro original de uma falha anterior é preservado',
  original === 'erro original que nao pode ser sobrescrito', original)

const explicada = (await pg.query<{ n: number }>(
  `select count(*)::int as n from sync_runs where error like 'Interrompida:%'`)).rows[0].n
check('as órfãs ganham um motivo legível', explicada === 2, `${explicada} explicada(s)`)

// ── Marca de recarga completa ───────────────────────────────────────────
// Sem ela, "precisa de recarga" só respondia "este conjunto FOI afetado?", e o
// contador ficava parado em 57 por mais que se recarregasse. A marca só avança
// quando a fonte foi lida INTEIRA (replaceParts) — é o que transforma a
// pergunta em "ainda PRECISA?".
console.log('\n── marca de recarga completa ──')
await pg.exec(`
  alter table datasets add column last_full_reload_at timestamptz;
  alter table datasets add column row_count bigint;
  alter table datasets add column last_sync_at timestamptz;
`)

const MARCAR = `update datasets set row_count = $2, last_sync_at = now(),
       last_full_reload_at = case when $3 then now() else last_full_reload_at end,
       updated_at = now() where id = $1 returning last_full_reload_at`

// Execução INCREMENTAL (replaceParts = false): não marca. É o ponto todo —
// uma execução normal não reescreve o passado, então não conserta nada.
const inc = await novoConjunto('daily', null)
const r1 = (await pg.query<{ last_full_reload_at: string | null }>(MARCAR, [inc, 10, false])).rows[0]
check('execução incremental NÃO marca recarga', r1.last_full_reload_at === null)

// Execução que releu a fonte inteira: marca.
const r2 = (await pg.query<{ last_full_reload_at: string | null }>(MARCAR, [inc, 10, true])).rows[0]
check('execução completa marca a recarga', r2.last_full_reload_at !== null)

// E a marca NÃO se perde numa execução incremental posterior.
const r3 = (await pg.query<{ last_full_reload_at: string | null }>(MARCAR, [inc, 20, false])).rows[0]
check('incremental posterior preserva a marca',
  String(r3.last_full_reload_at) === String(r2.last_full_reload_at))

await pg.close()
console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
