import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

interface ThemeState {
  theme: 'light' | 'dark'
  toggle: () => void
}

function apply(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      toggle: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark'
        apply(next)
        set({ theme: next })
      },
    }),
    {
      name: 'datahub-theme',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => { if (state) apply(state.theme) },
    },
  ),
)
