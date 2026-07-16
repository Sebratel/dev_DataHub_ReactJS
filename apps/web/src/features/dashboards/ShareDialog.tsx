// Compartilhamento do dashboard: visibilidade (equipe/privado) + convidados
// com nível visualizar/editar.
import { useEffect, useState } from 'react'
import { X, Trash2, Loader2, Users, Lock } from 'lucide-react'
import { api } from '@/lib/api'

interface Grant { id: string; email: string; level: 'view' | 'edit' }

export default function ShareDialog({ dashboardId, onClose }: { dashboardId: string; onClose: () => void }) {
  const [visibility, setVisibility] = useState<'tenant' | 'private'>('tenant')
  const [grants, setGrants] = useState<Grant[]>([])
  const [email, setEmail] = useState('')
  const [level, setLevel] = useState<'view' | 'edit'>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load() {
    api<{ visibility: 'tenant' | 'private'; grants: Grant[] }>(`/api/v1/dashboards/${dashboardId}/shares`)
      .then((r) => { setVisibility(r.visibility); setGrants(r.grants) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }
  useEffect(load, [dashboardId])

  async function setVis(v: 'tenant' | 'private') {
    setVisibility(v)
    await api(`/api/v1/dashboards/${dashboardId}`, { method: 'PATCH', body: JSON.stringify({ visibility: v }) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao salvar.'))
  }

  async function invite() {
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/dashboards/${dashboardId}/shares`, {
        method: 'POST', body: JSON.stringify({ email: email.trim(), level }),
      })
      setEmail('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao convidar.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    await api(`/api/v1/dashboards/${dashboardId}/shares/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Compartilhar dashboard</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[
            { v: 'tenant' as const, icon: Users, label: 'Toda a equipe', hint: 'Qualquer pessoa do domínio vê' },
            { v: 'private' as const, icon: Lock, label: 'Privado', hint: 'Só você e os convidados' },
          ].map(({ v, icon: Icon, label, hint }) => (
            <button key={v} onClick={() => void setVis(v)}
              className={`rounded-xl border p-3 text-left text-sm ${visibility === v
                ? 'border-accent bg-accent-soft dark:bg-zinc-800'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
              <Icon size={15} className={visibility === v ? 'text-accent' : 'text-zinc-400'} />
              <p className="mt-1 font-medium">{label}</p>
              <p className="text-xs text-zinc-500">{hint}</p>
            </button>
          ))}
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">Convidados</p>
          <div className="flex gap-2">
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void invite()}
              placeholder="email@sebratel.com.br"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            <select value={level} onChange={(e) => setLevel(e.target.value as 'view' | 'edit')}
              className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value="view">Visualizar</option>
              <option value="edit">Editar</option>
            </select>
            <button onClick={() => void invite()} disabled={busy || !email.trim()}
              className="rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Convidar'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
          <div className="mt-3 space-y-1.5">
            {grants.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-3 py-1.5 text-sm dark:border-zinc-800">
                <span className="min-w-0 flex-1 truncate">{g.email}</span>
                <span className="text-xs text-zinc-500">{g.level === 'edit' ? 'edita' : 'visualiza'}</span>
                <button onClick={() => void remove(g.id)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {grants.length === 0 && <p className="text-xs text-zinc-400">Ninguém convidado ainda.</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
