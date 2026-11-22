import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SessionUser } from '@datahub/shared'
import { clearHubSession } from './hubSession'

interface AuthState {
  user: SessionUser | null
  // Último ID token do Firebase — Bearer nas chamadas ao backend (/api).
  accessToken: string | null
  setUser: (u: SessionUser | null) => void
  setAccessToken: (t: string | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      setUser: (user) => set({ user }),
      setAccessToken: (accessToken) => set({ accessToken }),
      // A sessão do Hub sai junto: sem isso, um token recusado pelo servidor
      // continuaria sendo enviado depois de um novo login.
      logout: () => { clearHubSession(); set({ user: null, accessToken: null }) },
    }),
    { name: 'datahub-auth', storage: createJSONStorage(() => localStorage) },
  ),
)
