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
