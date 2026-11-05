// ─────────────────────────────────────────────────────────────────────────
// Verificações contínuas por conjunto (D-QLD-2, opção A) — a execução.
//
// Duas ocasiões, nenhuma toca na fonte:
//   • depois de cada carga bem-sucedida (gancho da fila, ver reconcile.ts):
//     volume do snapshot e identidade vazia/repetida no lake;
//   • a cada 15 min (agendador): o prazo de cada conjunto pela cadência.
//
// O estado fica em dataset_checks, uma linha por conjunto e verificação. O
// alerta sai na TROCA de estado — passou a falhar, voltou ao normal —, e não
// a cada execução: um conjunto atrasado avaliado de 15 em 15 min não pode
// render 96 avisos por dia.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { datasetDir, parquetGlob, listParquet } from '../../core/lake.js'
import { duckQuery } from '../query/duck.js'
import { referencedSlugs } from '../transform/derive.js'
import { notify } from '../alerts/notify.js'
import { staleVerdict, volumeVerdict } from './checkRules.js'

export type CheckName = 'stale' | 'volume' | 'identity'

const ROTULO: Record<CheckName, { falha: string; normal: string }> = {
  stale: { falha: 'Conjunto atrasado', normal: 'Prazo em dia de novo' },
  volume: { falha: 'Volume caiu', normal: 'Volume normal de novo' },
  identity: { falha: 'Identidade vazia ou repetida', normal: 'Identidade normal de novo' },
}

interface Alvo { id: string; tenantId: string; name: string; slug: string }

/** Grava o estado; avisa só quando ele muda. */
export async function setCheck(ds: Alvo, check: CheckName, status: 'ok' | 'fail', detail: string): Promise<void> {
  const antes = (await db.query(
    `select status from dataset_checks where dataset_id = $1 and check_name = $2`, [ds.id, check],
  )).rows[0]?.status as 'ok' | 'fail' | undefined
  await db.query(
    `insert into dataset_checks (dataset_id, check_name, status, detail)
     values ($1, $2, $3, $4)
     on conflict (dataset_id, check_name) do update set
       status = excluded.status, detail = excluded.detail, checked_at = now(),
       since = case when dataset_checks.status <> excluded.status then now() else dataset_checks.since end`,
    [ds.id, check, status, detail],
  )
  if (status === 'fail' && antes !== 'fail') {
    await notify(ds.tenantId, {
      key: `check:${check}:fail:${ds.id}`,
      kind: `check-${check}`,
      title: `${ROTULO[check].falha}: ${ds.name}`,
      lines: [`Conjunto ${ds.slug}.`, detail, 'Veja em Operar › Qualidade dos dados.'],
    })
  } else if (status === 'ok' && antes === 'fail') {
    await notify(ds.tenantId, {
      key: `check:${check}:ok:${ds.id}:${Date.now()}`,
      kind: `check-${check}-resolved`,
      title: `${ROTULO[check].normal}: ${ds.name}`,
      lines: [`Conjunto ${ds.slug}.`, detail],
    })
  }
}

/** Some com o estado quando a verificação deixa de se aplicar (virou manual, pausou…). */
async function clearCheck(datasetId: string, check: CheckName): Promise<void> {
  await db.query(`delete from dataset_checks where dataset_id = $1 and check_name = $2`, [datasetId, check])
}

const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`

/**
 * Depois de uma carga de FONTE bem-sucedida. Roda dentro da fila (gancho), só
 * sobre o lake — o custo é uma leitura colunar das colunas de identidade.
 */
export async function postLoadChecks(datasetId: string): Promise<void> {
  const r = (await db.query(
    `select d.id, d.tenant_id, d.name, d.slug, d.kind, d.sync_mode, d.dedupe_keys, t.slug as tenant_slug
       from datasets d join tenants t on t.id = d.tenant_id where d.id = $1`,
    [datasetId],
  )).rows[0]
  if (!r || r.kind === 'derived') return
  const ds: Alvo = { id: String(r.id), tenantId: String(r.tenant_id), name: String(r.name), slug: String(r.slug) }
  const snapshot = r.sync_mode === 'snapshot'

  // ── Volume (snapshot): esta carga contra a anterior ──────────────────
  if (snapshot) {
    const runs = (await db.query(
      `select rows from sync_runs where dataset_id = $1 and status = 'done' and mode = 'snapshot'
        order by started_at desc limit 2`,
      [datasetId],
    )).rows
    const v = runs.length === 2 ? volumeVerdict(Number(runs[1].rows), Number(runs[0].rows)) : null
    if (v) await setCheck(ds, 'volume', v.fail ? 'fail' : 'ok', v.detail)
  } else {
    await clearCheck(datasetId, 'volume')
  }

  // ── Identidade: vazia (qualquer modo) e repetida (snapshot) ──────────
  // No incremental, a compactação já desfez as repetidas — sobra a vazia:
  // linhas de identidade vazia contam como a MESMA linha e viram uma só. No
  // snapshot não há compactação, então a repetida no lake é repetida na
  // leitura (página relida no OFFSET) ou na fonte.
  const keys = ((r.dedupe_keys as string[] | null) ?? []).filter(Boolean)
  const dir = datasetDir(String(r.tenant_slug), String(r.slug))
  if (!keys.length || !listParquet(dir).length) {
    await clearCheck(datasetId, 'identity')
    return
  }
  const src = `read_parquet('${parquetGlob(dir)}')`
  const cols = keys.map(ident)
  const vazias = Number((await duckQuery(
    `select count(*) as n from ${src} where ${cols.map((c) => `${c} is null`).join(' or ')}`,
  )).rows[0]?.n ?? 0)
  const repetidas = snapshot
    ? Number((await duckQuery(
      `select (select count(*) from ${src} where ${cols.map((c) => `${c} is not null`).join(' and ')})
            - (select count(*) from (select distinct ${cols.join(', ')} from ${src}
                                      where ${cols.map((c) => `${c} is not null`).join(' and ')})) as n`,
    )).rows[0]?.n ?? 0)
    : 0
  const nomes = keys.join(' + ')
  if (vazias || repetidas) {
    const partes: string[] = []
    if (vazias) {
      partes.push(`${vazias.toLocaleString('pt-BR')} linha(s) com a identidade (${nomes}) vazia: ` +
        'linhas de identidade vazia contam como a mesma linha, e a compactação guarda só uma.')
    }
    if (repetidas) {
      partes.push(`${repetidas.toLocaleString('pt-BR')} linha(s) com a identidade (${nomes}) repetida no lake: ` +
        'ou a fonte não é única nessa identidade, ou a leitura repetiu páginas.')
    }
    await setCheck(ds, 'identity', 'fail', partes.join(' '))
  } else {
    await setCheck(ds, 'identity', 'ok', `Identidade (${nomes}) preenchida${snapshot ? ' e única' : ''} em todo o lake.`)
  }
}

/**
 * Prazo de todos os conjuntos pela cadência de cada um. Barata: só o
 * catálogo, nenhuma leitura de lake ou fonte. O agendador chama a cada 15 min.
 */
export async function runStaleChecks(now: Date = new Date()): Promise<number> {
  if (!isDbAvailable()) return 0
  const rows = (await db.query(
    `select d.id, d.tenant_id, d.name, d.slug, d.kind, d.sync_mode, d.sync_cadence, d.sync_paused_reason,
            d.last_sync_at, d.transform_sql,
            s.interval_minutes, s.start_time, s.end_time, s.weekdays
       from datasets d left join sync_schedules s on s.id = d.schedule_id`,
  )).rows

  // Última carga por slug, por tenant: é o que o calculado em cascata segue.
  const porTenant = new Map<string, Map<string, Date | null>>()
  for (const r of rows) {
    const t = String(r.tenant_id)
    if (!porTenant.has(t)) porTenant.set(t, new Map())
    porTenant.get(t)!.set(String(r.slug), r.last_sync_at ? new Date(r.last_sync_at) : null)
  }

  let atrasados = 0
  for (const r of rows) {
    const slugs = porTenant.get(String(r.tenant_id))!
    const inputs = r.sync_cadence === 'cascade' && r.transform_sql
      ? referencedSlugs(String(r.transform_sql), [...slugs.keys()])
        .filter((s) => s !== r.slug)
        .map((s) => ({ slug: s, lastSyncAt: slugs.get(s) ?? null }))
      : []
    const v = staleVerdict({
      kind: String(r.kind), syncMode: String(r.sync_mode), cadence: String(r.sync_cadence),
      paused: !!r.sync_paused_reason, lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at) : null,
      schedule: r.interval_minutes == null ? null : {
        intervalMinutes: Number(r.interval_minutes), startTime: String(r.start_time),
        endTime: String(r.end_time), weekdays: Number(r.weekdays),
      },
      inputs,
    }, now)
    try {
      if (!v.evaluate) {
        if (!v.keep) await clearCheck(String(r.id), 'stale')
        continue
      }
      if (v.late) atrasados++
      await setCheck(
        { id: String(r.id), tenantId: String(r.tenant_id), name: String(r.name), slug: String(r.slug) },
        'stale', v.late ? 'fail' : 'ok', v.detail,
      )
    } catch (e) {
      console.warn(`[qualidade] prazo de ${r.slug}: ${(e as Error).message}`)
    }
  }
  return atrasados
}
