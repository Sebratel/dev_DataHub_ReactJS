// Fachada única de autenticação. O resto do app não sabe (nem precisa saber)
// qual mecanismo está ativo.
//
// Dois caminhos convivem de propósito:
//   firebase  quando VITE_FIREBASE_* está configurado. SDK no bundle, sessão
//             persistida pelo próprio SDK, servidor conferindo a assinatura
//             localmente.
//   google    o caminho original (Google Identity Services). Continua aí para a
//             virada não exigir janela de indisponibilidade: instalação sem as
//             variáveis do Firebase segue funcionando exatamente como antes.
import { useAuthStore } from './authStore'
import {
  firebaseEnabled, loginWithFirebase, firebaseToken, logoutFirebase, AuthNetworkError,
} from './firebaseAuth'
import { loginWithGoogle, refreshGoogleToken } from './googleAuth'

export const authMode: 'firebase' | 'google' = firebaseEnabled ? 'firebase' : 'google'

export async function login(): Promise<string> {
  if (authMode === 'firebase') {
    const t = await loginWithFirebase()
    // Guarda o último token bom: é o lastro quando a renovação não conseguir
    // falar com o Google (ver currentToken).
    useAuthStore.getState().setAccessToken(t)
    return t
  }
  return loginWithGoogle()
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
  if (authMode !== 'firebase') return useAuthStore.getState().accessToken

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
  try {
    const t = authMode === 'firebase' ? await firebaseToken(true) : await refreshGoogleToken()
    if (t) useAuthStore.getState().setAccessToken(t)
    return t
  } catch {
    return null
  }
}

export async function logoutProvider(): Promise<void> {
  if (authMode === 'firebase') await logoutFirebase()
  useAuthStore.getState().logout()
}
