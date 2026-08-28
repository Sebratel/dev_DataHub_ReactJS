// Cliente HTTP: injeta o Bearer da sessão e, em 401, tenta UMA renovação antes
// de desistir.
//
// Regra que custou caro para aprender: falha ao RENOVAR não encerra a sessão.
// Antes, qualquer erro na renovação chamava logout() — e com o Google
// inalcançável (firewall, cookie de terceiro, rede oscilando) isso jogava a
// pessoa numa tela de login que, justamente por causa do mesmo bloqueio, não
// conseguia logar. Sessão válida virava beco sem saída.
//
// Agora quem encerra a sessão é um 401 que PERSISTE depois da tentativa de
// renovação. Se a renovação falhou por rede, o token atual segue valendo até
// vencer de verdade.
import { useAuthStore } from '@/store/authStore'
import { currentToken, refresh } from '@/store/authProvider'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function doFetch(path: string, init: RequestInit, token: string | null): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await currentToken()
  let res = await doFetch(path, init, token)

  if (res.status === 401 && token) {
    const fresh = await refresh()
    // Sem token novo: não dá para reenviar. Mantém o 401 original e deixa o
    // tratamento abaixo decidir — sem derrubar a sessão por causa da rede.
    if (fresh) res = await doFetch(path, init, fresh)
  }

  if (!res.ok) {
    let message = `Erro ${res.status}`
    try { message = ((await res.json()) as { error?: string }).error || message } catch { /* corpo não-JSON */ }
    // 401 que sobreviveu à renovação: aí sim a credencial não serve mais.
    if (res.status === 401 && token) useAuthStore.getState().logout()
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}
