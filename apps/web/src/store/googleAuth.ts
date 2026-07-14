// Serviço global de token do Google (portado do churn_mvp). Renova o
// access_token SILENCIOSAMENTE (prompt:'none') enquanto a sessão Google do
// navegador estiver ativa — evita deslogar a cada 1h.
import { useAuthStore } from './authStore'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

let tokenClient: { requestAccessToken: (opts?: { prompt?: string }) => void } | null = null
let scriptPromise: Promise<void> | null = null
let pending: { resolve: (t: string) => void; reject: (e: unknown) => void } | null = null
let refreshInFlight: Promise<string> | null = null

function loadScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    if (existing) {
      if (window.google?.accounts?.oauth2) return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Falha ao carregar Google Sign-In')))
      return
    }
    const s = document.createElement('script')
    s.src = GSI_SRC; s.async = true; s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Falha ao carregar Google Sign-In'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

async function ensureClient(): Promise<void> {
  await loadScript()
  if (tokenClient) return
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  if (!clientId) throw new Error('VITE_GOOGLE_CLIENT_ID não configurado')
  tokenClient = window.google!.accounts!.oauth2!.initTokenClient({
    client_id: clientId,
    scope: 'openid email profile',
    callback: (resp: { access_token?: string }) => {
      const p = pending; pending = null
      if (!p) return // callback tardio/duplicado do GSI → ignora
      if (resp.access_token) { useAuthStore.getState().setAccessToken(resp.access_token); p.resolve(resp.access_token) }
      else p.reject(new Error('Sem access_token na resposta do Google'))
    },
    error_callback: (err: unknown) => { const p = pending; pending = null; p?.reject(err) },
  })
}

// Pede um token com UI (login inicial).
export function loginWithGoogle(): Promise<string> {
  return requestToken('consent')
}

// Renova silenciosamente (sem popup). Uma renovação em voo por vez.
export function refreshGoogleToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = requestToken('none').finally(() => { refreshInFlight = null })
  return refreshInFlight
}

function requestToken(prompt: 'consent' | 'none' | ''): Promise<string> {
  return (async () => {
    await ensureClient()
    return new Promise<string>((resolve, reject) => {
      // Timeout: se o GSI não responder (cookies de terceiros bloqueados),
      // rejeita e libera — senão a renovação travaria para sempre.
      const timer = setTimeout(() => {
        if (pending) { pending = null; reject(new Error('Tempo esgotado na autenticação do Google')) }
      }, prompt === 'none' ? 15000 : 120000)
      pending = {
        resolve: (t) => { clearTimeout(timer); resolve(t) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      try { tokenClient!.requestAccessToken(prompt ? { prompt } : undefined) }
      catch (e) { clearTimeout(timer); pending = null; reject(e) }
    })
  })()
}
