// Fachada única de autenticação. O resto do app não sabe (nem precisa saber)
// como o login acontece.
//
// Um caminho só: Firebase Authentication (VITE_FIREBASE_*). SDK no bundle,
// sessão persistida pelo próprio SDK, servidor conferindo a assinatura
// localmente. O caminho antigo (Google Identity Services, access_token opaco)
// foi removido junto com o lado do servidor que o aceitava (SEG-07, decisão
// D-SEG-5 do comitê). Build sem as variáveis do Firebase não tem login — e o
// deploy recusa subir assim (ver docker-compose.yml).
//
// Segundo caminho, só de ENTRADA: o Data Hub aberto dentro do Hub Apps chega
// com ?sso_token=…; enterFromHub troca esse token por uma sessão do Data Hub
// (hubSession.ts), que passa a ter prioridade sobre o Firebase.
import type { SessionUser } from '@datahub/shared'
import { useAuthStore } from './authStore'
import { loginWithFirebase, firebaseToken, logoutFirebase, AuthNetworkError } from './firebaseAuth'
import { hubSessionToken, saveHubSession, setHubLoginError, takeSsoTokenFromUrl } from './hubSession'

export async function login(): Promise<string> {
  const t = await loginWithFirebase()
  // Guarda o último token bom: é o lastro quando a renovação não conseguir
  // falar com o Google (ver currentToken).
  useAuthStore.getState().setAccessToken(t)
  setHubLoginError(null)
  return t
}

/**
 * Entrada pelo Hub Apps. Roda ANTES de a aplicação montar (main.tsx): se a URL
 * traz ?sso_token, troca pela sessão e já deixa o usuário logado — sem isso o
 * AppShell veria "sem usuário" e mandaria para o login no meio da troca.
 * Falha não lança: vira a mensagem que a tela de login mostra.
 */
export async function enterFromHub(): Promise<void> {
  const sso = takeSsoTokenFromUrl()
  if (!sso) return
  try {
    const r = await fetch('/api/v1/auth/hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sso }),
    })
    const body = (await r.json().catch(() => ({}))) as {
      token?: string; expiresAt?: string; user?: SessionUser; error?: string
    }
    if (!r.ok || !body.token || !body.expiresAt || !body.user) {
      setHubLoginError(body.error || `Erro ${r.status} ao entrar pelo Hub Apps.`)
      return
    }
    saveHubSession({ token: body.token, expiresAt: body.expiresAt })
    useAuthStore.getState().setUser(body.user)
    setHubLoginError(null)
  } catch {
    setHubLoginError('Não foi possível falar com o servidor do Data Hub para entrar pelo Hub Apps.')
  }
}

/**
 * Token para a próxima requisição.
 *
 * Regra que corrige um bug real: quando a renovação falha por REDE, cai-se no
 * último token conhecido em vez de devolver null. Devolver null fazia a
 * requisição sair sem cabeçalho, a API responder "Token de autenticação
 * ausente" e o problema (bloqueio de rede) se disfarçar de falta de credencial.
 *
 * O token do Firebase vale 1 hora, então o lastro normalmente ainda serve — e
 * se não servir mais, quem diz isso é o 401 do servidor, que é a autoridade.
 */
export async function currentToken(): Promise<string | null> {
  // Sessão aberta pelo Hub vem primeiro: dentro do Hub é ela que vale.
  const hub = hubSessionToken()
  if (hub) return hub
  try {
    const t = await firebaseToken()
    if (t) useAuthStore.getState().setAccessToken(t)
    return t
  } catch (e) {
    if (e instanceof AuthNetworkError) {
      const ultimo = useAuthStore.getState().accessToken
      console.warn(`[auth] ${e.message} — usando o último token conhecido.`)
      return ultimo
    }
    throw e
  }
}

/**
 * Força uma renovação. Devolve null quando não foi possível — e null NÃO
 * significa "sessão encerrada": pode ser rede instável, cookie de terceiro
 * bloqueado ou o Google fora do ar. Quem decide que acabou é um 401 que
 * persiste depois da tentativa.
 */
export async function refresh(): Promise<string | null> {
  // A sessão do Hub não se renova aqui: quem emite outra é o Hub (recarregar).
  if (hubSessionToken()) return null
  try {
    const t = await firebaseToken(true)
    if (t) useAuthStore.getState().setAccessToken(t)
    return t
  } catch {
    return null
  }
}

export async function logoutProvider(): Promise<void> {
  await logoutFirebase()
  useAuthStore.getState().logout()
}
