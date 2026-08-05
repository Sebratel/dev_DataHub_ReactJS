// Admin › Monitoramento — health checks de endpoints (uptime/latência). O
// servidor pinga a cada minuto os que estão vencidos e grava no painel "Saúde
// das APIs". Aqui você cadastra/liga/desliga/exclui.
import { useEffect, useState } from 'react'
import { Activity, Plus, Trash2, RefreshCw, Loader2 } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'

interface Check {
  id: string; name: string; url: string; connection_id: string | null
  interval_minutes: number; enabled: boolean; last_run_at: string | null
  last: { ok: boolean; status: number | null; ms: number | null; at: string } | null
}

export default function MonitorPage() {
  const confirm = useConfirm()
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [conns, setConns] = useState<ConnectionInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [interval, setIntervalMin] = useState('5')
  const [connectionId, setConnectionId] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setError(null)
    try {
      const r = await api<{ checks: Check[] }>('/api/v1/health-checks')
      setChecks(r.checks)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar.')
    }
  }
  useEffect(() => {
    void load()
    api<{ connections: ConnectionInfo[] }>('/api/v1/connections')
      .then((r) => setConns(r.connections.filter((c) => c.kind === 'http')))
      .catch(() => {})
  }, [])

  async function add() {
    if (!name.trim() || !/^https?:\/\//i.test(url.trim())) { setError('Informe nome e uma URL válida.'); return }
    setBusy(true); setError(null)
    try {
      await api('/api/v1/health-checks', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), url: url.trim(), intervalMinutes: Number(interval) || 5, connectionId: connectionId || null }),
      })
      setName(''); setUrl(''); setConnectionId('')
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar.')
    } finally { setBusy(false) }
  }

  async function toggle(c: Check) {
    await api(`/api/v1/health-checks/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: c.name, url: c.url, connectionId: c.connection_id, intervalMinutes: c.interval_minutes, enabled: !c.enabled }),
    }).then(load).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }

  async function remove(c: Check) {
    if (!(await confirm({ title: 'Excluir verificação', message: `Excluir o monitor "${c.name}"?`, danger: true, confirmLabel: 'Excluir' }))) return
    await api(`/api/v1/health-checks/${c.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }

  const inp = 'rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="mx-auto max-w-screen-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <Activity size={22} className="text-accent" /> Monitoramento
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Uptime e latência de endpoints. O servidor pinga a cada minuto os que estão vencidos e registra no painel "Saúde das APIs".</p>
        </div>
        <button onClick={load} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <RefreshCw size={14} /> Atualizar
        </button>
      </div>

      {/* Novo check */}
      <div className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Nome</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="API de faturas" />
        </label>
        <label className="min-w-[240px] flex-1 text-sm"><span className="mb-1 block text-xs text-zinc-500">URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${inp} w-full`} placeholder="https://api.empresa.com/health" />
        </label>
        <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Intervalo (min)</span>
          <input value={interval} onChange={(e) => setIntervalMin(e.target.value)} className={`${inp} w-24`} inputMode="numeric" />
        </label>
        <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Auth (opcional)</span>
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={inp}>
            <option value="">— sem auth —</option>
            {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button onClick={add} disabled={busy} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Adicionar
        </button>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      <div className="mt-5 overflow-hidden rounded-xl border border-zinc-200 shadow-card dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Nome</th>
              <th className="px-4 py-2.5 font-medium">URL</th>
              <th className="px-4 py-2.5 font-medium">Intervalo</th>
              <th className="px-4 py-2.5 font-medium">Última</th>
              <th className="px-4 py-2.5 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {checks?.map((c) => (
              <tr key={c.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${!c.enabled ? 'bg-zinc-300' : c.last ? (c.last.ok ? 'bg-emerald-500' : 'bg-red-500') : 'bg-amber-400'}`}
                    title={!c.enabled ? 'desligado' : c.last ? (c.last.ok ? 'no ar' : 'fora') : 'aguardando'} />
                </td>
                <td className="px-4 py-2 font-medium">{c.name}</td>
                <td className="max-w-[280px] truncate px-4 py-2 font-mono text-xs text-zinc-500" title={c.url}>{c.url}</td>
                <td className="px-4 py-2 text-xs text-zinc-500">{c.interval_minutes} min</td>
                <td className="px-4 py-2 text-xs text-zinc-500">
                  {c.last ? `${c.last.ok ? 'OK' : 'falha'}${c.last.status ? ` (${c.last.status})` : ''} · ${c.last.ms} ms` : '—'}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="inline-flex items-center gap-2">
                    <button onClick={() => void toggle(c)} className={`rounded-lg border px-2 py-1 text-xs ${c.enabled ? 'border-zinc-200 text-zinc-600 dark:border-zinc-700' : 'border-accent bg-accent-soft text-secondary dark:bg-zinc-800'}`}>
                      {c.enabled ? 'Pausar' : 'Ativar'}
                    </button>
                    <button onClick={() => void remove(c)} className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-red-500 dark:border-zinc-700" title="Excluir">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {checks?.length === 0 && <p className="p-8 text-center text-sm text-zinc-500">Nenhum monitor ainda. Adicione um endpoint acima.</p>}
        {checks === null && !error && <p className="p-8 text-center text-sm text-zinc-500">Carregando…</p>}
      </div>
    </div>
  )
}
