// ─────────────────────────────────────────────────────────────────────────
// Alertas: o que precisa chegar a alguém sem depender de uma tela aberta.
//
// Até aqui o Data Hub não avisava ninguém de nada (MON-03): uma carga pausava
// às 3 h e o gestor descobria às 10 h, pelo número errado. O princípio
// aprovado na R4 (P-QLD-2, "falha visível, nunca silenciosa") pede o
// contrário.
//
// O canal é UM webhook por tenant que recebe {"text": "..."} — o formato do
// Google Chat, que o Slack e um fluxo do n8n também aceitam. É a opção B da
// D-MON-3 (a decisão formal do canal é da R6); escolhida por ser a que a casa
// já usa no vigia de infraestrutura.
//
// Duas regras:
//   • nunca derruba quem chamou. Alerta é efeito colateral: uma falha no
//     webhook não pode virar falha da carga ou da conciliação;
//   • o mesmo assunto não é reenviado dentro da janela de silêncio. Quem clica
//     "Conciliar agora" cinco vezes num conjunto quebrado não pode inundar o
//     espaço com cinco avisos iguais.
// ─────────────────────────────────────────────────────────────────────────
import { db, isDbAvailable } from '../../db/pool.js'
import { decryptSecret } from '../../core/crypto.js'

/** Mesmo assunto, uma vez a cada 12 h. */
export const SILENCIO_MS = 12 * 60 * 60 * 1000
const TIMEOUT_MS = 10_000

export interface AlertInput {
  /** Identidade do assunto, para não repetir (ex.: 'reconcile:diverged:<id>'). */
  key: string
  kind: string
  title: string
  lines: string[]
}

export type AlertOutcome = 'sent' | 'failed' | 'no-channel' | 'silenced'

/** O texto que vai para o canal. Negrito com *…*, que o Chat e o Slack entendem. */
export function alertText(title: string, lines: string[]): string {
  return [`*Data Hub · ${title}*`, ...lines.filter(Boolean)].join('\n')
}

/**
 * Valida o endereço do webhook antes de gravar. HTTPS e sem credencial na URL:
 * o endereço já é o segredo, e um http:// mandaria o alerta (e o segredo) em
 * claro pela rede.
 */
export function validateWebhookUrl(raw: string): string {
  const url = String(raw ?? '').trim()
  let u: URL
  try { u = new URL(url) } catch { throw new Error('Endereço do webhook inválido.') }
  if (u.protocol !== 'https:') throw new Error('O webhook precisa ser https://.')
  if (u.username || u.password) throw new Error('Tire usuário e senha do endereço do webhook.')
  return url
}

/** "chat.googleapis.com …a1b2" — reconhecível, sem expor a chave. */
export function webhookHint(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host} …${url.slice(-4)}`
  } catch {
    return `…${url.slice(-4)}`
  }
}

/** POST {text} no webhook. Devolve o erro em texto, ou null se entregou. */
export async function postWebhook(url: string, text: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (r.ok) return null
    const corpo = (await r.text().catch(() => '')).slice(0, 200)
    return `HTTP ${r.status}${corpo ? `: ${corpo}` : ''}`
  } catch (e) {
    const err = e as Error
    return err.name === 'TimeoutError' ? `Sem resposta em ${TIMEOUT_MS / 1000} s.` : err.message
  }
}

async function webhookDo(tenantId: string): Promise<string | null> {
  const s = (await db.query(
    `select webhook_enc, enabled from alert_settings where tenant_id = $1`, [tenantId],
  )).rows[0]
  if (!s?.webhook_enc || !s.enabled) return null
  return decryptSecret(String(s.webhook_enc))
}

/**
 * Registra e envia um alerta. Nunca lança: o pior caso é o alerta ficar
 * registrado como 'failed' ou 'no-channel', visível na tela de Qualidade.
 */
export async function notify(tenantId: string, a: AlertInput): Promise<AlertOutcome> {
  if (!isDbAvailable()) return 'no-channel'
  try {
    // Só o que SAIU silencia. Um aviso registrado sem canal não chegou a
    // ninguém: quem cadastra o webhook depois precisa recebê-lo na próxima vez.
    const recente = (await db.query(
      `select 1 from alert_events
        where tenant_id = $1 and key = $2 and status = 'sent' and created_at > $3
        limit 1`,
      [tenantId, a.key, new Date(Date.now() - SILENCIO_MS)],
    )).rowCount
    if (recente) {
      console.log(`[alertas] "${a.key}" já avisado nas últimas ${SILENCIO_MS / 3_600_000} h; não repete.`)
      return 'silenced'
    }

    const text = alertText(a.title, a.lines)
    let status: Exclude<AlertOutcome, 'silenced'> = 'no-channel'
    let error: string | null = null
    let url: string | null = null
    try {
      url = await webhookDo(tenantId)
    } catch (e) {
      // Cifra trocada (CONNECTIONS_SECRET) torna o endereço ilegível: falha
      // com o motivo, em vez de se passar por "sem canal".
      status = 'failed'
      error = `Não foi possível ler o webhook cadastrado: ${(e as Error).message}`
    }
    if (url) {
      error = await postWebhook(url, text)
      status = error ? 'failed' : 'sent'
    }
    await db.query(
      `insert into alert_events (tenant_id, key, kind, title, body, status, error)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, a.key, a.kind, a.title, a.lines.join('\n'), status, error],
    )
    if (status === 'failed') console.warn(`[alertas] "${a.title}" não foi entregue: ${error}`)
    return status
  } catch (e) {
    console.warn(`[alertas] falha ao registrar "${a.key}": ${(e as Error).message}`)
    return 'failed'
  }
}

/** Atalho para alertas sobre UM conjunto: descobre o tenant pelo próprio conjunto. */
export async function notifyDataset(datasetId: string, a: AlertInput): Promise<AlertOutcome> {
  try {
    const t = (await db.query(`select tenant_id from datasets where id = $1`, [datasetId])).rows[0]
    if (!t) return 'no-channel'
    return await notify(String(t.tenant_id), a)
  } catch (e) {
    console.warn(`[alertas] falha ao localizar o conjunto ${datasetId}: ${(e as Error).message}`)
    return 'failed'
  }
}
