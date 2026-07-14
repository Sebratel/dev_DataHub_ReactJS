import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SessionUser } from '@datahub/shared'

interface AuthState {
  user: SessionUser | null
  // access_token do Google — Bearer nas chamadas ao backend (/api).
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
      logout: () => set({ user: null, accessToken: null }),
    }),
    { name: 'datahub-auth', storage: createJSONStorage(() => localStorage) },
  ),
)
