// Sessão aberta pelo Hub Apps (Data Hub embutido no Hub).
//
// Fica no sessionStorage, não no localStorage: ela vale para ESTE quadro do Hub
// e some quando a aba fecha. Abrir o Data Hub direto numa aba nova não herda a
// sessão do Hub — que é o que o modo "só pelo Hub" precisa. Recarregar o Hub
// emite um token novo, então perder a sessão aqui nunca custa nada.

const KEY = 'datahub-hub-session'

interface HubSession { token: string; expiresAt: string }

function storage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/** Bearer da sessão do Hub, ou null se não há (ou venceu). */
export function hubSessionToken(): string | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as HubSession
    if (!v?.token || !(Date.parse(v.expiresAt) > Date.now())) { s.removeItem(KEY); return null }
    return v.token
  } catch { return null }
}

export function saveHubSession(v: HubSession): void {
  try { storage()?.setItem(KEY, JSON.stringify(v)) } catch { /* modo privado: vale só em memória */ }
}

export function clearHubSession(): void {
  try { storage()?.removeItem(KEY) } catch { /* nada a limpar */ }
}

/**
 * Tira o ?sso_token da barra de endereço e o devolve. Sai da URL antes de
 * qualquer outra coisa: assim ele não fica no histórico nem vai junto quando
 * alguém copia o link.
 */
export function takeSsoTokenFromUrl(): string | null {
  const url = new URL(window.location.href)
  const t = url.searchParams.get('sso_token')
  if (!t) return null
  url.searchParams.delete('sso_token')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  return t
}

/** Está dentro de um quadro (o Hub)? Na dúvida (acesso negado ao topo), sim. */
export function isFramed(): boolean {
  try { return window.self !== window.top } catch { return true }
}

// Motivo da última entrada pelo Hub que falhou — a tela de login mostra.
let hubLoginError: string | null = null
export const getHubLoginError = () => hubLoginError
export function setHubLoginError(msg: string | null): void { hubLoginError = msg }
