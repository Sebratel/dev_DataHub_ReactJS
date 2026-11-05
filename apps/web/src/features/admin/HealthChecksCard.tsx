// Verificações de saúde de endpoints (uptime e latência). O servidor chama a
// cada minuto as que estão vencidas e grava no painel "Saúde das APIs"; um
// endpoint fora do ar entra em "Precisa de atenção agora". Era a antiga tela
// Monitoramento, que virou um cartão da Saúde da plataforma.
import { useEffect, useState } from 'react'
import { Radio, Plus, Trash2, Loader2 } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'
import { hoursSince, lagSince } from '@/lib/freshness'
import { useConfirm } from '@/components/Dialogs'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'

interface Check {
  id: string; name: string; url: string; connection_id: string | null
  interval_minutes: number; enabled: boolean; last_run_at: string | null
  last: { ok: boolean; status: number | null; ms: number | null; at: string } | null
}

export default function HealthChecksCard({ onChange }: { onChange?: () => void }) {
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
    try {
      const r = await api<{ checks: Check[] }>('/api/v1/health-checks')
      setChecks(r.checks); setError(null)
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
      await load(); onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar.')
    } finally { setBusy(false) }
  }

  async function toggle(c: Check) {
    await api(`/api/v1/health-checks/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: c.name, url: c.url, connectionId: c.connection_id, intervalMinutes: c.interval_minutes, enabled: !c.enabled }),
    }).then(load).then(() => onChange?.()).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }

  async function remove(c: Check) {
    if (!(await confirm({ title: 'Excluir verificação', message: `Excluir o monitor "${c.name}"?`, danger: true, confirmLabel: 'Excluir' }))) return
    await api(`/api/v1/health-checks/${c.id}`, { method: 'DELETE' })
      .then(load).then(() => onChange?.()).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }

  const inp = 'h-[30px] rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const lbl = 'mb-1 block text-[10.5px] text-zinc-500'
  const btn = 'flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2 text-[11px] font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

  return (
    <Card>
      <CardHead icon={Radio} title="Verificações de saúde de endpoints"
        sub="o servidor chama cada URL no intervalo e registra status e latência" />
      <div className="flex flex-wrap items-end gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <label><span className={lbl}>Nome</span>
          <input id="hc-name" value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="API de faturas" />
        </label>
        <label className="min-w-[240px] flex-1"><span className={lbl}>URL</span>
          <input id="hc-url" value={url} onChange={(e) => setUrl(e.target.value)} className={`${inp} w-full`} placeholder="https://api.empresa.com/health" />
        </label>
        <label><span className={lbl}>Intervalo (min)</span>
          <input id="hc-interval" value={interval} onChange={(e) => setIntervalMin(e.target.value)} className={`${inp} w-20`} inputMode="numeric" />
        </label>
        <label><span className={lbl}>Autenticação (opcional)</span>
          <select id="hc-auth" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={inp}>
            <option value="">— sem autenticação —</option>
            {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button onClick={() => void add()} disabled={busy}
          className="flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Adicionar
        </button>
      </div>
      {error && <p className="px-3 pt-2 text-[11.5px] text-crit dark:text-crit-dark">{error}</p>}
      {checks && checks.length > 0 ? (
        <DataGrid fixed className="min-w-[760px]">
          <thead>
            <tr>
              <Th className="w-[96px]">Estado</Th>
              <Th className="w-[200px]">Nome</Th>
              <Th>URL</Th>
              <Th className="w-[90px]">Intervalo</Th>
              <Th className="w-[170px]">Última chamada</Th>
              <Th className="w-[130px]" />
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <Tr key={c.id}>
                <Td>
                  {!c.enabled ? <Pill>pausada</Pill>
                    : !c.last ? <Pill tone="info">aguardando</Pill>
                      : c.last.ok ? <Pill tone="ok" dot>no ar</Pill> : <Pill tone="crit" dot>fora</Pill>}
                </Td>
                <Td><span className="block truncate font-medium">{c.name}</span></Td>
                <Td muted title={c.url}><span className="block truncate font-mono text-[11px]">{c.url}</span></Td>
                <Td muted>{c.interval_minutes} min</Td>
                <Td muted>
                  <span className="text-[11px] tabular-nums">
                    {c.last ? `${c.last.status ? `HTTP ${c.last.status}` : c.last.ok ? 'ok' : 'erro'} · ${c.last.ms ?? '—'} ms · ${lagSince(hoursSince(c.last.at))}` : '—'}
                  </span>
                </Td>
                <Td>
                  <span className="flex items-center justify-end gap-1.5">
                    <button onClick={() => void toggle(c)} className={btn}>{c.enabled ? 'Pausar' : 'Ativar'}</button>
                    <button onClick={() => void remove(c)} className={`${btn} text-zinc-400 hover:text-crit`} title="Excluir" aria-label={`Excluir ${c.name}`}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataGrid>
      ) : (
        <p className="px-3 py-6 text-center text-[11.5px] text-zinc-400">
          {checks === null ? 'Carregando…' : 'Nenhum endpoint monitorado. Adicione um acima.'}
        </p>
      )}
    </Card>
  )
}
