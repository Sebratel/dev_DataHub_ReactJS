// Admin › Usuários e Acessos (Sprint 8). Duas abas:
//   • Usuários — quem já entrou no hub e seu papel (admin/editor/viewer).
//   • Times — grupos para conceder acesso a conjuntos em bloco; cria time e
//     gerencia membros. A concessão de conjuntos vive no diálogo "Acessos" de
//     cada conjunto (detalhe do dataset).
import { useEffect, useState } from 'react'
import { UsersRound, UserCog, Plus, Trash2, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'

interface UserRow { email: string; name: string; picture: string | null; lastLoginAt: string | null; roles: string[] }
interface TeamRow { id: string; slug: string; name: string; description: string; memberCount: number }
interface Member { email: string; name: string | null }

const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', editor: 'Editor', viewer: 'Visualizador' }

export default function AccessPage() {
  const [tab, setTab] = useState<'users' | 'teams'>('users')
  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-semibold">Usuários e Acessos</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Papéis dos usuários e times para conceder acesso aos conjuntos de dados.
      </p>
      <div className="mt-5 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {[
          { t: 'users' as const, icon: UserCog, label: 'Usuários' },
          { t: 'teams' as const, icon: UsersRound, label: 'Times' },
        ].map(({ t, icon: Icon, label }) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${tab === t
              ? 'border-accent font-semibold text-zinc-900 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      <div className="mt-6">{tab === 'users' ? <UsersTab /> : <TeamsTab />}</div>
    </div>
  )
}

function UsersTab() {
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  function load() {
    api<{ users: UserRow[] }>('/api/v1/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar usuários.'))
  }
  useEffect(load, [])

  async function setRole(email: string, role: string) {
    setError(null)
    try {
      await api(`/api/v1/admin/users/${encodeURIComponent(email)}/role`, {
        method: 'PATCH', body: JSON.stringify({ role }),
      })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao alterar papel.')
    }
  }

  if (error) return <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
  if (!users) return <p className="text-sm text-zinc-500">Carregando…</p>
  if (!users.length) return <p className="text-sm text-zinc-500">Nenhum usuário entrou no hub ainda.</p>

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
          <tr>
            <th className="px-4 py-2.5 font-medium">Usuário</th>
            <th className="px-4 py-2.5 font-medium">Último acesso</th>
            <th className="px-4 py-2.5 text-right font-medium">Papel</th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-zinc-950">
          {users.map((u) => {
            const role = u.roles.includes('admin') ? 'admin' : u.roles.includes('editor') ? 'editor' : 'viewer'
            return (
              <tr key={u.email} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    {u.picture
                      ? <img src={u.picture} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
                      : <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-brand text-xs font-bold text-[#1a1a1a]">{u.name[0]}</div>}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{u.name}</p>
                      <p className="truncate text-xs text-zinc-500">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <select value={role} onChange={(e) => void setRole(u.email, e.target.value)}
                    className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                    {Object.entries(ROLE_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TeamsTab() {
  const confirm = useConfirm()
  const [teams, setTeams] = useState<TeamRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [openTeam, setOpenTeam] = useState<TeamRow | null>(null)

  function load() {
    api<{ teams: TeamRow[] }>('/api/v1/admin/teams')
      .then((r) => setTeams(r.teams))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar times.'))
  }
  useEffect(load, [])

  async function createTeam() {
    if (!newName.trim()) return
    setCreating(true)
    setError(null)
    try {
      await api('/api/v1/admin/teams', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) })
      setNewName('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar time.')
    } finally {
      setCreating(false)
    }
  }

  async function removeTeam(id: string) {
    if (!(await confirm({
      title: 'Excluir time',
      message: 'Excluir este time? As concessões dele aos conjuntos serão removidas.',
      danger: true, confirmLabel: 'Excluir',
    }))) return
    await api(`/api/v1/admin/teams/${id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <div>
      <div className="flex gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void createTeam()}
          placeholder="Nome do novo time (ex.: Financeiro)"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        <button onClick={() => void createTeam()} disabled={creating || !newName.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Criar time
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <div className="mt-5 grid gap-2">
        {teams === null && <p className="text-sm text-zinc-500">Carregando…</p>}
        {teams?.length === 0 && <p className="text-sm text-zinc-500">Nenhum time criado. Crie o primeiro acima.</p>}
        {teams?.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <UsersRound size={18} className="text-secondary" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.name}</p>
              <p className="text-xs text-zinc-500">{t.memberCount} membro(s)</p>
            </div>
            <button onClick={() => setOpenTeam(t)}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Membros
            </button>
            <button onClick={() => void removeTeam(t.id)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      {openTeam && <MembersDialog team={openTeam} onClose={() => { setOpenTeam(null); load() }} />}
    </div>
  )
}

function MembersDialog({ team, onClose }: { team: TeamRow; onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load() {
    api<{ members: Member[] }>(`/api/v1/admin/teams/${team.id}/members`)
      .then((r) => setMembers(r.members))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar membros.'))
  }
  useEffect(load, [team.id])

  async function add() {
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/admin/teams/${team.id}/members`, { method: 'POST', body: JSON.stringify({ email: email.trim() }) })
      setEmail('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao adicionar membro.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(memberEmail: string) {
    await api(`/api/v1/admin/teams/${team.id}/members/${encodeURIComponent(memberEmail)}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Membros — {team.name}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <div className="flex gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="email@sebratel.com.br"
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
          <button onClick={() => void add()} disabled={busy || !email.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : 'Adicionar'}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <div className="mt-3 space-y-1.5">
          {members.map((m) => (
            <div key={m.email} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-3 py-1.5 text-sm dark:border-zinc-800">
              <span className="min-w-0 flex-1 truncate">{m.name ? `${m.name} · ${m.email}` : m.email}</span>
              <button onClick={() => void remove(m.email)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {members.length === 0 && <p className="text-xs text-zinc-400">Nenhum membro ainda.</p>}
        </div>
      </div>
    </div>
  )
}
