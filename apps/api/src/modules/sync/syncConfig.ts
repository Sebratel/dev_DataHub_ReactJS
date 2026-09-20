// ─────────────────────────────────────────────────────────────────────────
// Regra ÚNICA de gravação da configuração de sincronização de um conjunto.
//
// Existem dois caminhos que gravam isto: a tela do conjunto (um por vez) e a
// padronização em lote (dezenas de uma vez). As validações aqui são sutis —
// quando zerar o watermark, por que a 2ª chave exige identidade, qual piso
// anula qual — e duas cópias delas divergiriam na primeira correção feita só
// de um lado. Os dois caminhos chamam esta função.
//
// Lança Error com a mensagem pronta para o usuário; quem chama devolve 400.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'

export interface SyncConfigInput {
  syncMode: 'live' | 'snapshot' | 'incremental'
  incrementalKey?: string | null
  incrementalKey2?: string | null
  syncCadence?: 'daily' | 'hourly' | 'manual' | null
  syncSince?: string | null
  syncSinceDays?: number | string | null
  dedupeKeys?: unknown
  watermarkLagMinutes?: number | string | null
}

export interface SyncConfigResult {
  slug: string
  /** Campos efetivamente gravados — vai para a auditoria. */
  applied: {
    syncMode: string; incrementalKey: string | null; incrementalKey2: string | null
    syncCadence: string | null; since: string | null; sinceDays: number | null
    dedupe: string[]; lag: number
  }
  /** true quando a mudança invalidou o progresso e a próxima carga recomeça. */
  watermarkReset: boolean
  /** true quando o conjunto DEIXOU de seguir um agendamento nomeado. Quem
   *  chama precisa dizer isso na tela: é uma consequência real de pedir
   *  cadência fixa, e some sem aviso se ninguém contar. */
  detachedFromSchedule: boolean
}

export async function applySyncConfig(datasetId: string, input: SyncConfigInput): Promise<SyncConfigResult> {
  const { syncMode, incrementalKey, incrementalKey2, syncCadence, syncSince, syncSinceDays, dedupeKeys, watermarkLagMinutes } = input

  if (!['live', 'snapshot', 'incremental'].includes(syncMode)) {
    throw new Error('syncMode deve ser live, snapshot ou incremental.')
  }
  if (syncCadence != null && !['daily', 'hourly', 'manual'].includes(syncCadence)) {
    throw new Error('syncCadence deve ser daily, hourly ou manual.')
  }

  const incremental = syncMode === 'incremental'
  const known = new Set((await db.query(
    `select key from dataset_fields where dataset_id = $1`, [datasetId],
  )).rows.map((r) => String(r.key)))

  // Fora do incremental, tudo que é incremental zera — não fica configuração
  // órfã descrevendo um comportamento que o modo atual não executa.
  const key1 = incremental ? String(incrementalKey ?? '') : ''
  const key2 = incremental && incrementalKey2 ? String(incrementalKey2) : ''
  const dedupe: string[] = incremental && Array.isArray(dedupeKeys)
    ? [...new Set((dedupeKeys as unknown[]).map(String).filter(Boolean))] : []

  if (incremental && !known.has(key1)) throw new Error('incrementalKey precisa ser um campo do dataset.')
  if (key2 && !known.has(key2)) throw new Error('A 2ª chave incremental precisa ser um campo do dataset.')
  if (key2 && key2 === key1) throw new Error('A 2ª chave precisa ser diferente da primeira.')
  const unknownDedupe = dedupe.filter((k) => !known.has(k))
  if (unknownDedupe.length) throw new Error(`Identidade da linha inválida: ${unknownDedupe.join(', ')}.`)
  // Mesma regra da constraint do banco, dita em português: sem identidade, duas
  // passadas trazem a mesma linha duas vezes e nada as junta depois.
  if (key2 && !dedupe.length) {
    throw new Error(
      'Para usar duas chaves é preciso definir a identidade da linha (ex.: id) — ' +
      'sem ela, a linha que foi criada E editada entraria duplicada no lake.',
    )
  }

  // "Ponto de partida": data FIXA ou RELATIVA (últimos N dias), nunca as duas.
  const since = incremental && syncSince != null && String(syncSince).trim() !== ''
    ? String(syncSince).trim() : null
  const sinceDays = incremental && syncSinceDays != null && String(syncSinceDays).trim() !== ''
    ? Number(syncSinceDays) : null
  if (sinceDays != null && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 3650)) {
    throw new Error('O piso relativo deve ser um número inteiro de dias, entre 1 e 3650.')
  }
  if (since != null && sinceDays != null) throw new Error('Escolha um piso só: data fixa OU últimos N dias.')
  const lag = incremental && watermarkLagMinutes != null ? Number(watermarkLagMinutes) : 0
  if (!Number.isInteger(lag) || lag < 0 || lag > 10080) {
    throw new Error('A folga de reconferência deve ser de 0 a 10080 minutos (7 dias).')
  }

  const current = (await db.query(
    `select sync_mode, sync_since, sync_since_days, incremental_key, incremental_key_2, schedule_id
       from datasets where id = $1`, [datasetId],
  )).rows[0]
  if (!current) throw new Error('Conjunto de dados não encontrado.')
  // Zera o watermark (força recarga do zero) quando o MODO muda OU quando o piso
  // muda — em ambos os casos, o que o dataset contém foi redefinido. Mudar só a
  // cadência preserva o progresso incremental.
  const modeChanged = current.sync_mode !== syncMode
  const sinceChanged = (current.sync_since ?? null) !== since
    || (current.sync_since_days ?? null) !== sinceDays
  const resetAll = modeChanged || sinceChanged
  // Trocar a CHAVE também invalida o watermark dela: o valor guardado é o maior
  // da coluna ANTIGA e, aplicado à nova, pularia tudo que estiver atrás dele.
  const reset1 = resetAll || (current.incremental_key ?? null) !== (key1 || null)
  const reset2 = resetAll || (current.incremental_key_2 ?? null) !== (key2 || null)

  const row = (await db.query(
    // schedule_id CAI JUNTO quando a cadência muda. A constraint
    // datasets_schedule_pairing_check exige que `sync_cadence = 'schedule'` e
    // `schedule_id is not null` andem juntos; esta rota só grava cadências de
    // relógio fixo (daily/hourly/manual), então deixar o schedule_id antigo
    // produz exatamente o par proibido — cadência 'hourly' com agendamento
    // preenchido — e o Postgres recusa a linha inteira.
    //
    // Era invisível enquanto a única porta era a tela do conjunto, que evita
    // reenviar a cadência quando o conjunto segue um agendamento. A
    // padronização em lote não tem como evitar: ela justamente TIRA conjuntos
    // do agendamento diário para colocá-los em outra cadência. Resultado: 100%
    // do lote recusado pelo banco.
    //
    // Sair do agendamento é o comportamento correto aqui, e não um efeito
    // colateral: pedir cadência fixa a um conjunto que segue agendamento é
    // pedir para ele parar de seguir o agendamento.
    `update datasets set
       sync_mode = $2, incremental_key = $3, incremental_key_2 = $4,
       sync_cadence = coalesce($5, sync_cadence),
       schedule_id = case when $5 is null then schedule_id else null end,
       sync_since = $6, sync_since_days = $7,
       dedupe_keys = $8, watermark_lag_minutes = $9,
       watermark   = case when $10 then null else watermark end,
       watermark_2 = case when $11 then null else watermark_2 end,
       updated_at = now()
     where id = $1 returning slug`,
    [datasetId, syncMode, key1 || null, key2 || null,
     syncCadence ?? null, since, sinceDays, dedupe, lag, reset1, reset2],
  )).rows[0]

  return {
    slug: String(row.slug),
    applied: {
      syncMode, incrementalKey: key1 || null, incrementalKey2: key2 || null,
      syncCadence: syncCadence ?? null, since, sinceDays, dedupe, lag,
    },
    watermarkReset: reset1 || reset2,
    detachedFromSchedule: syncCadence != null && current.schedule_id != null,
  }
}
