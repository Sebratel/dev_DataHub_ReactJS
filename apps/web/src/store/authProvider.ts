// Fachada única de autenticação. O resto do app não sabe (nem precisa saber)
// qual mecanismo está ativo.
//
// Dois caminhos convivem de propósito:
//   firebase  quando VITE_FIREBASE_* está configurado. SDK no bundle, popup no
//             domínio do projeto, servidor conferindo a assinatura localmente.
//             É o que continua funcionando com o firewall bloqueando o Google.
//   google    o caminho original (Google Identity Services). Continua aí para a
//             virada não exigir janela de indisponibilidade: instalação sem as
//             variáveis do Firebase segue funcionando exatamente como antes.
import { useAuthStore } from './authStore'
import { firebaseEnabled, loginWithFirebase, firebaseToken, logoutFirebase } from './firebaseAuth'
import { loginWithGoogle, refreshGoogleToken } from './googleAuth'

export const authMode: 'firebase' | 'google' = firebaseEnabled ? 'firebase' : 'google'

export async function login(): Promise<string> {
  if (authMode === 'firebase') {
    const t = await loginWithFirebase()
    // Guarda para o caminho síncrono (o Explorador monta URL de download).
    useAuthStore.getState().setAccessToken(t)
    return t
  }
  return loginWithGoogle()
}

/** Token para a próxima requisição, renovado se necessário. */
export async function currentToken(): Promise<string | null> {
  if (authMode === 'firebase') {
    const t = await firebaseToken()
    if (t) useAuthStore.getState().setAccessToken(t)
    return t
  }
  return useAuthStore.getState().accessToken
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
