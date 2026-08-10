// Compartilhamento de notebook. Mesmo modelo dos painéis e dos conjuntos —
// visibilidade (time/privado) + concessões a TIMES ou PESSOAS — com uma
// diferença: aqui o acesso é um booleano (pode editar ou não), não um enum de
// níveis. Um notebook ou você mexe nas células ou só lê o que já rodou.
//
// A remoção é por e-mail/time, não por id: notebook_grants tem chave composta.
import { useCallback, useEffect, useState } from 'react'
import { X, Trash2, Loader2, Users, Lock, UsersRound, Mail, Pencil, Eye } from 'lucide-react'
import { api } from '@/lib/api'

interface Grant {
  teamId: string | null
  teamName: string | null
  email: string | null
  canEdit: boolean
}
interface TeamOpt { id: string; name: string }
interface SharesResponse {
  visibility: 'tenant' | 'private'
  ownerEmail: string
  canShare: boolean
  teams: TeamOpt[]
  grants: Grant[]
}

export default function ShareNotebookDialog({
  slug, onClose, onVisibility,
}: {
  slug: string
  onClose: () => void
  /** Avisa a tela de origem para ela não mostrar visibilidade defasada. */
  onVisibility?: (v: 'tenant' | 'private') => void
}) {
  const [visibility, setVisibility] = useState<'tenant' | 'private'>('private')
  const [canShare, setCanShare] = useState(false)
  const [teams, setTeams] = useState<TeamOpt[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [mode, setMode] = useState<'team' | 'email'>('email')
  const [teamId, setTeamId] = useState('')
  const [email, setEmail] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<SharesResponse>(`/api/v1/notebooks/${slug}/shares`)
      .then((r) => {
        setVisibility(r.visibility)
        setCanShare(r.canShare)
        setTeams(r.teams)
        setGrants(r.grants)
        setTeamId((cur) => cur || (r.teams[0]?.id ?? ''))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [slug])
  useEffect(load, [load])

  async function setVis(v: 'tenant' | 'private') {
    const prev = visibility
    setVisibility(v)
    try {
      await api(`/api/v1/notebooks/${slug}`, { method: 'PUT', body: JSON.stringify({ visibility: v }) })
      onVisibility?.(v)
    } catch (e) {
      setVisibility(prev) // não fingir que salvou
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
    }
  }

  async function invite() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'team' && !teamId) throw new Error('Selecione um time.')
      if (mode === 'email' && !email.trim()) throw new Error('Informe um e-mail.')
      const body = mode === 'team'
        ? { teamId, canEdit }
        : { email: email.trim().toLowerCase(), canEdit }
      await api(`/api/v1/notebooks/${slug}/shares`, { method: 'POST', body: JSON.stringify(body) })
      setEmail('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao compartilhar.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(g: Grant) {
    const q = g.teamId ? `teamId=${encodeURIComponent(g.teamId)}` : `email=${encodeURIComponent(g.email ?? '')}`
    try {
      await api(`/api/v1/notebooks/${slug}/shares?${q}`, { method: 'DELETE' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao remover.')
    }
    load()
  }

  const locked = !canShare

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-3.5 shadow-card-lg dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Compartilhar notebook</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={16} /></button>
        </div>

        {locked && (
          <p className="mb-3 rounded-lg border border-zinc-200 px-3 py-2 text-[11.5px] text-zinc-500 dark:border-zinc-700">
            Só o dono (ou um administrador) altera o compartilhamento. Você está vendo quem tem acesso.
          </p>
        )}

        {/* Visibilidade */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { v: 'tenant' as const, icon: Users, label: 'Todo o time', hint: 'Qualquer pessoa do tenant abre' },
            { v: 'private' as const, icon: Lock, label: 'Restrito', hint: 'Só você e os convidados' },
          ].map(({ v, icon: Icon, label, hint }) => (
            <button key={v} onClick={() => void setVis(v)} disabled={locked}
              className={`rounded-xl border p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60 ${visibility === v
                ? 'border-accent bg-accent-soft dark:bg-zinc-800'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
              <Icon size={14} className={visibility === v ? 'text-accent' : 'text-zinc-400'} />
              <p className="mt-1 text-[12px] font-medium">{label}</p>
              <p className="text-[11px] text-zinc-500">{hint}</p>
            </button>
          ))}
        </div>

        {/* Convidar */}
        <div className={`mt-3.5 ${visibility === 'tenant' ? 'opacity-50' : ''}`}>
          <p className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-zinc-400">Convidar</p>
          <div className="mb-1.5 flex gap-1">
            {[
              { m: 'email' as const, icon: Mail, label: 'Pessoa' },
              { m: 'team' as const, icon: UsersRound, label: 'Time' },
            ].map(({ m, icon: Icon, label }) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] ${mode === m
                  ? 'border-accent bg-accent-soft dark:bg-zinc-800'
                  : 'border-zinc-200 dark:border-zinc-700'}`}>
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            {mode === 'team' ? (
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={locked}
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-950">
                {teams.length === 0 && <option value="">Nenhum time criado</option>}
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <input value={email} onChange={(e) => setEmail(e.target.value)} disabled={locked}
                onKeyDown={(e) => { if (e.key === 'Enter') void invite() }}
                placeholder="email@sebratel.com.br"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-950" />
            )}
            <select value={canEdit ? 'edit' : 'view'} onChange={(e) => setCanEdit(e.target.value === 'edit')} disabled={locked}
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-950">
              <option value="view">Visualizar</option>
              <option value="edit">Editar</option>
            </select>
            <button onClick={() => void invite()} disabled={busy || locked || visibility === 'tenant'}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : 'Convidar'}
            </button>
          </div>
          {visibility === 'tenant' && (
            <p className="mt-1.5 text-[11px] text-zinc-400">
              Com "todo o time" não há o que convidar — todo mundo já vê. Convites servem para dar EDIÇÃO a alguém específico: mude para restrito, ou conceda mesmo assim depois.
            </p>
          )}
        </div>

        {error && <p className="mt-2 text-[11.5px] text-crit dark:text-crit-dark">{error}</p>}

        {/* Quem tem acesso */}
        <div className="mt-3.5 space-y-1">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-100 px-2.5 py-1.5 text-[12px] dark:border-zinc-800">
            <Mail size={13} className="shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate text-zinc-500">dono</span>
            <span className="text-[11px] text-zinc-400">acesso total</span>
          </div>
          {grants.map((g) => (
            <div key={g.teamId ?? g.email}
              className="flex items-center gap-2 rounded-lg border border-zinc-100 px-2.5 py-1.5 text-[12px] dark:border-zinc-800">
              {g.teamId
                ? <UsersRound size={13} className="shrink-0 text-info dark:text-info-dark" />
                : <Mail size={13} className="shrink-0 text-zinc-400" />}
              <span className="min-w-0 flex-1 truncate">{g.teamName ?? g.email}</span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500">
                {g.canEdit ? <><Pencil size={10} /> edita</> : <><Eye size={10} /> lê</>}
              </span>
              {!locked && (
                <button onClick={() => void remove(g)} title="Remover acesso"
                  className="shrink-0 text-zinc-300 hover:text-crit dark:text-zinc-600">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
          {grants.length === 0 && (
            <p className="pt-0.5 text-[11px] text-zinc-400">
              Ninguém convidado ainda — adicione um time ou uma pessoa acima.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
