// Cliente HTTP: injeta o Bearer do Google e, em 401, tenta UMA renovação
// silenciosa antes de deslogar (padrão do churn_mvp).
import { useAuthStore } from '@/store/authStore'
import { refreshGoogleToken } from '@/store/googleAuth'

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
  const store = useAuthStore.getState()
  let res = await doFetch(path, init, store.accessToken)

  if (res.status === 401 && store.accessToken) {
    try {
      const fresh = await refreshGoogleToken()
      res = await doFetch(path, init, fresh)
    } catch {
      store.logout()
    }
  }

  if (!res.ok) {
    let message = `Erro ${res.status}`
    try { message = ((await res.json()) as { error?: string }).error || message } catch { /* corpo não-JSON */ }
    if (res.status === 401) useAuthStore.getState().logout()
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}
