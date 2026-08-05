// Acessos de um Conjunto de Dados (Sprint 8): visibilidade (tenant/privado) +
// concessões a TIMES ou PESSOAS, cada uma com permissão de exportar.
// Aberto por admin ou pelo dono do conjunto (o backend valida ambos).
import { useEffect, useState } from 'react'
import { X, Trash2, Loader2, Users, Lock, UsersRound, Mail, Download } from 'lucide-react'
import { api } from '@/lib/api'

interface Grant {
  id: string
  teamId: string | null
  teamName: string | null
  email: string | null
  canExport: boolean
}
interface TeamOpt { id: string; name: string }
interface GrantsResponse { visibility: 'tenant' | 'private'; teams: TeamOpt[]; grants: Grant[] }

export default function AccessDialog({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [visibility, setVisibility] = useState<'tenant' | 'private'>('private')
  const [teams, setTeams] = useState<TeamOpt[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [mode, setMode] = useState<'team' | 'email'>('team')
  const [teamId, setTeamId] = useState('')
  const [email, setEmail] = useState('')
  const [canExport, setCanExport] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load() {
    api<GrantsResponse>(`/api/v1/admin/datasets/${slug}/grants`)
      .then((r) => {
        setVisibility(r.visibility)
        setTeams(r.teams)
        setGrants(r.grants)
        if (!teamId && r.teams.length) setTeamId(r.teams[0].id)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar acessos.'))
  }
  useEffect(load, [slug])

  async function setVis(v: 'tenant' | 'private') {
    setVisibility(v)
    await api(`/api/v1/admin/datasets/${slug}/visibility`, { method: 'PATCH', body: JSON.stringify({ visibility: v }) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao salvar.'))
  }

  async function addGrant() {
    setBusy(true)
    setError(null)
    try {
      const body = mode === 'team'
        ? { teamId, canExport }
        : { email: email.trim().toLowerCase(), canExport }
      if (mode === 'team' && !teamId) throw new Error('Selecione um time.')
      if (mode === 'email' && !email.trim()) throw new Error('Informe um e-mail.')
      await api(`/api/v1/admin/datasets/${slug}/grants`, { method: 'POST', body: JSON.stringify(body) })
      setEmail('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao conceder acesso.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleExport(g: Grant) {
    await api(`/api/v1/admin/datasets/${slug}/grants/${g.id}`, {
      method: 'PATCH', body: JSON.stringify({ canExport: !g.canExport }),
    }).catch((e) => setError(e instanceof Error ? e.message : 'Falha ao salvar.'))
    load()
  }

  async function remove(id: string) {
    await api(`/api/v1/admin/datasets/${slug}/grants/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold">Acessos — {name}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <p className="mb-4 text-xs text-zinc-500">Quem pode visualizar e exportar este conjunto de dados.</p>

        {/* Visibilidade */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { v: 'private' as const, icon: Lock, label: 'Restrito', hint: 'Só quem receber acesso abaixo' },
            { v: 'tenant' as const, icon: Users, label: 'Toda a empresa', hint: 'Qualquer pessoa do domínio vê' },
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

        {/* Conceder acesso */}
        <div className={`mt-4 ${visibility === 'tenant' ? 'opacity-50' : ''}`}>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">Conceder acesso</p>
          <div className="mb-2 flex gap-1">
            {[
              { m: 'team' as const, icon: UsersRound, label: 'Time' },
              { m: 'email' as const, icon: Mail, label: 'Pessoa' },
            ].map(({ m, icon: Icon, label }) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${mode === m
                  ? 'border-accent bg-accent-soft dark:bg-zinc-800'
                  : 'border-zinc-200 dark:border-zinc-700'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {mode === 'team' ? (
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                {teams.length === 0 && <option value="">Nenhum time criado</option>}
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <input value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addGrant()}
                placeholder="email@sebratel.com.br"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            )}
            <button onClick={() => void addGrant()} disabled={busy || visibility === 'tenant'}
              className="rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'Conceder'}
            </button>
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
            <input type="checkbox" checked={canExport} onChange={(e) => setCanExport(e.target.checked)} />
            Pode exportar (CSV/Excel)
          </label>
        </div>

        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

        {/* Concessões atuais */}
        <div className="mt-4 space-y-1.5">
          {grants.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-3 py-2 text-sm dark:border-zinc-800">
              {g.teamId ? <UsersRound size={14} className="shrink-0 text-secondary" /> : <Mail size={14} className="shrink-0 text-zinc-400" />}
              <span className="min-w-0 flex-1 truncate">{g.teamName ?? g.email}</span>
              <button title={g.canExport ? 'Pode exportar' : 'Sem exportar'} onClick={() => void toggleExport(g)}
                className={`rounded p-1 ${g.canExport ? 'text-emerald-500' : 'text-zinc-300 dark:text-zinc-600'}`}>
                <Download size={14} />
              </button>
              <button onClick={() => void remove(g.id)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {grants.length === 0 && visibility === 'private' && (
            <p className="text-xs text-zinc-400">Ninguém tem acesso ainda — conceda a um time ou pessoa acima.</p>
          )}
        </div>
      </div>
    </div>
  )
}
