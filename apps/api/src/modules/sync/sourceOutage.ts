// ─────────────────────────────────────────────────────────────────────────
// Fonte fora do ar não é erro que se repete.
//
// Incidente de 17/11/2026: às 08:51 o Postgres do Voalle recusou conexão por
// alguns minutos (connect ECONNREFUSED). Um conjunto com agendamento é tentado
// de novo a cada minuto depois de uma falha — o "última carga" só anda quando
// dá certo —, então três recusas em pouco mais de um minuto bastaram para a
// regra das três falhas pausar TODOS os conjuntos da fonte. Pausado, ninguém
// tenta mais sozinho: a fonte voltou, e os conjuntos não.
//
// A pausa existe para o erro que se repete igual (tabela que sumiu, SQL
// inválido), onde insistir só custa leitura na produção. Fonte inalcançável
// não lê nada. Para ela, em vez de pausar:
//   • a CONEXÃO entra em espera crescente (2, 4, 8, 15 e 30 min), e o
//     agendador não a tenta antes disso — nem martela a fonte, nem ocupa a
//     fila global com tentativas que vão esperar o tempo de conexão;
//   • um alerta por FONTE ("fora do ar" e "de volta"), não um por conjunto;
//   • o primeiro sucesso de qualquer conjunto dela encerra a espera.
// A espera vive na memória do processo: um reinício só antecipa a próxima
// tentativa, o que é inofensivo.
// ─────────────────────────────────────────────────────────────────────────
import { db } from '../../db/pool.js'
import { getConnector } from '../../connectors/registry.js'
import { notifyDataset } from '../alerts/notify.js'

// Só falha de CHEGAR à fonte. Tempo esgotado no meio de uma consulta, conexão
// derrubada durante a leitura e afins ficam de fora: esses leem a produção e
// podem se repetir igual — continuam contando para a pausa.
const INALCANCAVEL = [
  // Recusa e rota inexistente só acontecem ao conectar. ETIMEDOUT, não: um
  // "read ETIMEDOUT" no meio da leitura conta para a pausa.
  /\b(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bconnect ETIMEDOUT\b/i,
  /\bgetaddrinfo (ENOTFOUND|EAI_AGAIN)\b/i,
  /Connection terminated due to connection timeout/i, // pg: não chegou a conectar
  /timeout exceeded when trying to connect/i, // pg-pool
  /the database system is (starting up|shutting down|in recovery mode)/i, // Postgres reiniciando
  /\bFailed to connect to\b/i, // SQL Server (tedious)
]

export function isSourceUnreachable(erro: string): boolean {
  return INALCANCAVEL.some((re) => re.test(erro))
}

/**
 * O texto de um erro, mesmo quando a mensagem vem vazia. O Node devolve um
 * AggregateError sem mensagem quando o nome da fonte resolve para IPv4 e IPv6
 * e as duas tentativas falham — a carga ficava registrada com erro em branco.
 */
export function errorText(e: unknown): string {
  const err = e as { message?: string; code?: string; errors?: unknown[] }
  if (err?.message) return err.message
  if (Array.isArray(err?.errors) && err.errors.length) {
    return err.errors.map((x) => (x as Error)?.message || String(x)).join('; ')
  }
  return err?.code ? String(err.code) : String(e)
}

const DEGRAUS_MIN = [2, 4, 8, 15, 30]

interface Espera { ate: number; tentativas: number; desde: number }
const esperas = new Map<string, Espera>()

/** Até quando a conexão está em espera, ou null se pode ser tentada. */
export function sourceWaitUntil(connectionId: string, now = Date.now()): Date | null {
  const e = esperas.get(connectionId)
  return e && now < e.ate ? new Date(e.ate) : null
}

/**
 * Registra que a fonte não respondeu. Várias falhas dentro da mesma espera
 * (os conjuntos que já estavam na fila) não aumentam o degrau.
 * Devolve true na primeira falha da sequência — a hora de avisar.
 */
function marcaFora(connectionId: string, now: number): boolean {
  const e = esperas.get(connectionId)
  if (e && now < e.ate) return false
  const tentativas = (e?.tentativas ?? 0) + 1
  const min = DEGRAUS_MIN[Math.min(tentativas, DEGRAUS_MIN.length) - 1]
  esperas.set(connectionId, { ate: now + min * 60_000, tentativas, desde: e?.desde ?? now })
  return tentativas === 1
}

const nomeDa = (connectionId: string) => getConnector(connectionId)?.name ?? connectionId
const hora = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })

/**
 * Chamado na falha de uma carga de FONTE. Se a fonte estava inalcançável,
 * registra a espera, avisa uma vez e devolve true: a falha não conta para a
 * pausa. Devolve false para qualquer outro erro.
 */
export async function onSourceFailure(
  ds: { id: string; slug: string; connectionId: string | null }, erro: string, now = Date.now(),
): Promise<boolean> {
  if (!ds.connectionId || !isSourceUnreachable(erro)) return false
  const primeira = marcaFora(ds.connectionId, now)
  const e = esperas.get(ds.connectionId)!
  console.warn(`[sync] ${ds.slug}: fonte ${nomeDa(ds.connectionId)} inalcançável; ` +
    `nova tentativa automática a partir das ${hora(e.ate)} (não conta para a pausa).`)
  if (primeira) {
    await notifyDataset(ds.id, {
      key: `source:down:${ds.connectionId}`, kind: 'source-down',
      title: `Fonte fora do ar: ${nomeDa(ds.connectionId)}`,
      lines: [
        `A carga de ${ds.slug} não conseguiu conectar: ${erro.slice(0, 200)}`,
        'Os conjuntos desta fonte não são pausados: o Data Hub tenta de novo sozinho, com intervalo crescente ' +
        '(2 a 30 min), e avisa quando ela voltar.',
      ],
    })
  }
  return true
}

/** Chamado no sucesso de uma carga de FONTE: encerra a espera e avisa a volta. */
export async function onSourceSuccess(ds: { id: string; connectionId: string | null }, now = Date.now()): Promise<void> {
  if (!ds.connectionId) return
  const e = esperas.get(ds.connectionId)
  if (!e) return
  esperas.delete(ds.connectionId)
  const min = Math.max(1, Math.round((now - e.desde) / 60_000))
  await notifyDataset(ds.id, {
    key: `source:up:${ds.connectionId}:${now}`, kind: 'source-up',
    title: `Fonte de volta: ${nomeDa(ds.connectionId)}`,
    lines: [`Voltou a responder depois de cerca de ${min} min fora; as cargas seguem normalmente.`],
  })
}

/**
 * Retoma os conjuntos que a regra antiga pausou por fonte inalcançável — com a
 * regra de hoje, eles nem teriam sido pausados. Roda no agendador a cada
 * 15 min (e resolve, depois do deploy, os pausados do incidente de 17/11).
 * Quem foi pausado por outro erro continua pausado.
 */
export async function resumeSourceOutagePauses(): Promise<number> {
  let n = 0
  for (const r of (await db.query(
    `select id, slug, sync_paused_reason from datasets where sync_paused_reason is not null`,
  )).rows) {
    const motivo = String(r.sync_paused_reason)
    if (!isSourceUnreachable(motivo)) continue
    const ok = (await db.query(
      `update datasets set sync_failures = 0, sync_paused_reason = null, updated_at = now()
        where id = $1 and sync_paused_reason = $2`,
      [r.id, motivo],
    )).rowCount
    if (ok) {
      n++
      console.log(`[sync] ${String(r.slug)}: retomado — estava pausado só porque a fonte não respondia.`)
    }
  }
  return n
}

/** Para os testes: começa sem nenhuma espera. */
export function resetSourceOutages(): void { esperas.clear() }
