// Login por Firebase Authentication.
//
// A diferença que importa em relação ao caminho antigo (Google Identity
// Services) não é o Google ser outro — é DE ONDE o navegador baixa as coisas:
//
//   GSI       precisa buscar https://accounts.google.com/gsi/client em tempo de
//             execução, ANTES de qualquer clique. Domínio bloqueado no firewall
//             = o botão não faz nada, e não há mensagem que ajude.
//   Firebase  vem no bundle, instalado pelo npm. Nada é baixado do Google para a
//             tela de login existir, e o popup vai para o domínio do PROJETO
//             (<projeto>.firebaseapp.com), não para accounts.google.com.
//
// Além disso o Firebase mantém a sessão sozinho (IndexedDB) e renova o ID token
// contra securetoken.googleapis.com — então recarregar a página não exige nova
// ida ao Google, e o servidor confere a assinatura localmente.
//
// É o mesmo desenho do dev_HUBBI_ReactJS, que é justamente o projeto que
// continua entrando com o firewall ligado.
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut,
  browserLocalPersistence, setPersistence, type Auth, type User,
} from 'firebase/auth'

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
}

/** Firebase só entra em ação se estiver configurado — senão o app usa o GSI. */
export const firebaseEnabled = !!(cfg.apiKey && cfg.authDomain && cfg.projectId)

let app: FirebaseApp | null = null
let auth: Auth | null = null

function getAuthInstance(): Auth {
  if (auth) return auth
  if (!firebaseEnabled) throw new Error('Firebase não configurado nesta instalação.')
  app = getApps().length ? getApp() : initializeApp({
    apiKey: cfg.apiKey!, authDomain: cfg.authDomain!, projectId: cfg.projectId!,
    ...(cfg.appId ? { appId: cfg.appId } : {}),
  })
  auth = getAuth(app)
  // Persistência local: fechar a aba não desloga. Falha em modo privado — e aí
  // a sessão vale só enquanto a aba viver, que é o comportamento aceitável.
  void setPersistence(auth, browserLocalPersistence).catch(() => {})
  return auth
}

/** Resolve quando o Firebase termina de restaurar (ou não) a sessão salva. */
export function firebaseReady(): Promise<User | null> {
  return new Promise((resolve) => {
    const a = getAuthInstance()
    const off = onAuthStateChanged(a, (u) => { off(); resolve(u) }, () => { off(); resolve(null) })
  })
}

export async function loginWithFirebase(): Promise<string> {
  const a = getAuthInstance()
  const provider = new GoogleAuthProvider()
  // `hd` faz o Google já filtrar o seletor pelo domínio da empresa. Não é
  // controle de acesso — quem valida o domínio é o servidor —, é só evitar que
  // a pessoa escolha a conta pessoal e receba um "sem acesso" logo depois.
  const domain = import.meta.env.VITE_ALLOWED_DOMAIN as string | undefined
  if (domain) provider.setCustomParameters({ hd: domain })

  const cred = await signInWithPopup(a, provider)
  return cred.user.getIdToken()
}

/**
 * ID token corrente. O SDK devolve o que está em memória e só vai à rede quando
 * falta pouco para vencer — então isto é barato de chamar a cada request.
 */
export async function firebaseToken(force = false): Promise<string | null> {
  if (!firebaseEnabled) return null
  const a = getAuthInstance()
  const u = a.currentUser ?? (await firebaseReady())
  if (!u) return null
  try {
    return await u.getIdToken(force)
  } catch {
    // Renovação falhou (rede/firewall). Devolve null em vez de estourar: quem
    // decide que a sessão acabou é o 401 de verdade, não uma oscilação.
    return null
  }
}

export async function logoutFirebase(): Promise<void> {
  if (!firebaseEnabled || !auth) return
  await signOut(auth).catch(() => {})
}

// ── Erros legíveis ───────────────────────────────────────────────────────
// O erro cru do Firebase é uma parede: vem com httpMetadata, cachePolicy,
// originTrials e outros vinte campos irrelevantes, e a parte que importa
// (error_description) fica no meio, longe o bastante para a caixa de erro
// cortar justamente ela. Aqui a causa vira uma frase acionável, e o texto
// original fica disponível para quem precisar.
export interface AuthErrorInfo { message: string; detail: string }

const POR_CODIGO: Record<string, string> = {
  'auth/unauthorized-domain':
    'Este domínio não está autorizado no Firebase. Adicione-o em Authentication → Settings → Authorized domains.',
  'auth/operation-not-allowed':
    'O provedor Google não está ativado. Ative em Authentication → Sign-in method → Google.',
  'auth/popup-blocked':
    'O navegador bloqueou a janela do Google. Libere pop-ups para este site e tente de novo.',
  'auth/popup-closed-by-user':
    'A janela do Google foi fechada antes de concluir.',
  'auth/cancelled-popup-request':
    'Havia outra tentativa de login aberta. Tente novamente.',
  'auth/network-request-failed':
    'Não foi possível falar com o Google. Verifique a conexão ou o bloqueio de rede.',
  'auth/internal-error':
    'O Firebase recusou a resposta do Google. Confira as credenciais do provedor em Authentication → Sign-in method → Google.',
}

export function describeAuthError(e: unknown): AuthErrorInfo {
  const detail = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: string })?.code ?? ''

  // invalid_client vem do endpoint de token do Google, não do Firebase: o par
  // Client ID/secret do provedor não existe ou não confere. É o erro que mais
  // confunde, porque a mensagem fala de "credential" e a pessoa procura na
  // chave de API, que não tem nada a ver.
  if (/invalid_client/i.test(detail)) {
    return {
      message: 'As credenciais OAuth do provedor Google estão inválidas. No Firebase, em ' +
        'Authentication → Sign-in method → Google → Configuração do SDK da Web, o ID e a chave ' +
        'secreta do cliente precisam corresponder a um cliente OAuth existente no mesmo projeto.',
      detail,
    }
  }
  if (/redirect_uri_mismatch/i.test(detail)) {
    return {
      message: 'O URI de redirecionamento do cliente OAuth não bate. Adicione ' +
        `https://${cfg.authDomain ?? '<projeto>.firebaseapp.com'}/__/auth/handler ` +
        'nos URIs de redirecionamento autorizados do cliente.',
      detail,
    }
  }
  if (code && POR_CODIGO[code]) return { message: POR_CODIGO[code], detail }
  return { message: detail.slice(0, 300), detail }
}
