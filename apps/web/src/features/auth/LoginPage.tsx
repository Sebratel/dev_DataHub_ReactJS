import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, Loader2 } from 'lucide-react'
import type { SessionUser } from '@datahub/shared'
import { loginWithGoogle } from '@/store/googleAuth'
import { useAuthStore } from '@/store/authStore'
import { api } from '@/lib/api'

export default function LoginPage() {
  const navigate = useNavigate()
  const setUser = useAuthStore((s) => s.setUser)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLogin() {
    setBusy(true)
    setError(null)
    try {
      await loginWithGoogle()
      // /auth/me provisiona o usuário no tenant e devolve papéis.
      const { user } = await api<{ user: SessionUser }>('/api/v1/auth/me')
      setUser(user)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao entrar. Tente novamente.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-white">
            <Database size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Data Hub</h1>
            <p className="text-sm text-zinc-500">Sebratel</p>
          </div>
        </div>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Seus dados, dashboards e IA em um só lugar. Entre com sua conta corporativa.
        </p>
        <button
          onClick={handleLogin}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          Entrar com Google
        </button>
        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      </div>
    </div>
  )
}
