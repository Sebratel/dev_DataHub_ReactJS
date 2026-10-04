// Publicação do conjunto no Databricks (admin; configurar é do master).
//
// O painel responde três perguntas, nesta ordem: este conjunto sai daqui? para
// onde exatamente? e o último envio deu certo? A terceira é a que mais importa
// no dia a dia — um envio que falha não interrompe nada no Data Hub, então sem
// esta tela a falha ficaria só no log do servidor.
import { useEffect, useState } from 'react'
import { Upload, Loader2, Lock, Check, AlertTriangle } from 'lucide-react'
import type { DatasetDetail, DatabricksRun } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'

interface StatusGeral {
  enabled: boolean
  host: string | null
  volumePath: string
  hasCredential: boolean
  authMode: string | null
}

const STATUS_COR: Record<string, string> = {
  SUCCESS: 'text-emerald-600 dark:text-emerald-400',
  FAILED: 'text-red-600 dark:text-red-400',
  SKIPPED: 'text-zinc-500',
}

function quando(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export default function DatabricksPanel({ dataset, onChanged }: {
  dataset: DatasetDetail; onChanged: () => void
}) {
  const db = dataset.databricks
  const [enabled, setEnabled] = useState(db?.enabled ?? false)
  const [mode, setMode] = useState(db?.mode ?? 'SNAPSHOT')
  const [layer, setLayer] = useState<string>(db?.layer ?? '')
  const [status, setStatus] = useState<StatusGeral | null>(null)
  const [runs, setRuns] = useState<DatabricksRun[]>([])
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [salvo, setSalvo] = useState(false)
  const isMaster = useAuthStore((s) => !!s.user?.master)

  useEffect(() => {
    api<StatusGeral>('/api/v1/databricks/status')
      .then(setStatus)
      .catch(() => { /* sem o estado geral, o painel ainda configura */ })
  }, [])

  async function carregarRuns() {
    try {
      const r = await api<{ runs: DatabricksRun[] }>(`/api/v1/datasets/${dataset.id}/databricks-runs`)
      setRuns(r.runs)
    } catch { /* histórico é informativo; falhar aqui não trava a tela */ }
  }
  useEffect(() => { void carregarRuns() }, [dataset.id])

  const gravado = JSON.stringify({ e: db?.enabled ?? false, m: db?.mode ?? 'SNAPSHOT', l: db?.layer ?? '' })
  const alterado = gravado !== JSON.stringify({ e: enabled, m: mode, l: layer })

  async function salvar() {
    setBusy(true); setErro(null); setSalvo(false)
    try {
      await api(`/api/v1/datasets/${dataset.id}/databricks`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled, mode, layer }),
      })
      setSalvo(true)
      setTimeout(() => setSalvo(false), 4000)
      onChanged()
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar.')
    } finally { setBusy(false) }
  }

  async function enviarAgora() {
    setBusy(true); setErro(null)
    try {
      await api(`/api/v1/datasets/${dataset.id}/databricks-publish`, { method: 'POST' })
      await carregarRuns()
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao enviar.')
      await carregarRuns() // a falha também vira linha no histórico
    } finally { setBusy(false) }
  }

  const camadaEfetiva = layer || db?.effectiveLayer || 'bronze'
  const destino = status
    ? `${status.volumePath}/${camadaEfetiva}/${dataset.slug}/dt=…`
    : null
  const ultimo = runs[0] ?? null
  const ctrl = 'rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Publicação no Databricks</h2>

      {status && !status.enabled && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            A integração está <strong>desligada no servidor</strong>{' '}
            (<code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">DATABRICKS_SYNC_ENABLED=false</code>).
            O que você marcar aqui fica guardado, mas nenhum envio sai até ela ser ligada.
          </p>
        </div>
      )}
      {status?.enabled && !status.hasCredential && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            Integração ligada, mas <strong>sem credencial</strong>: falta
            {' '}<code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">DATABRICKS_TOKEN</code> ou o par
            {' '}<code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">CLIENT_ID/SECRET</code> no ambiente.
          </p>
        </div>
      )}
      {!isMaster && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <Lock size={14} className="mt-0.5 shrink-0 text-zinc-400" />
          <p className="text-xs leading-relaxed text-zinc-500">
            Somente o <strong>administrador master</strong> liga a publicação: aqui o conjunto inteiro sai da rede
            interna para um workspace externo. Você continua podendo <strong>enviar agora</strong> e ver o histórico.
          </p>
        </div>
      )}

      <fieldset disabled={!isMaster} className="contents">
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
              className="size-4 rounded border-zinc-300 dark:border-zinc-600" />
            <span>Publicar no Databricks</span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Modo de envio</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={ctrl}>
              <option value="SNAPSHOT">Snapshot (substitui a tabela a cada envio)</option>
              {/* Fica para depois do piloto — mostrar desabilitado explica a
                  ausência melhor do que esconder a opção. */}
              <option value="INCREMENTAL" disabled>Incremental (depois do piloto)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Camada</span>
            <select value={layer} onChange={(e) => setLayer(e.target.value)} className={ctrl}>
              <option value="">Padrão ({db?.effectiveLayer ?? 'bronze'})</option>
              <option value="bronze">bronze</option>
              <option value="prata">prata</option>
              <option value="ouro">ouro</option>
            </select>
          </label>
        </div>
      </fieldset>

      <p className="mt-3 text-xs text-zinc-500">
        Destino: {destino
          ? <><code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{destino}</code>{' '}
            → tabela <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{db?.table}</code></>
          : '—'}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={salvar} disabled={!isMaster || !alterado || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} Salvar
        </button>
        <button onClick={enviarAgora} disabled={busy || !enabled}
          title={!enabled ? 'Ligue "Publicar no Databricks" e salve antes de enviar.' : undefined}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700">
          <Upload size={14} /> Enviar agora
        </button>
        {salvo && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <Check size={13} /> Salvo
          </span>
        )}
        {erro && <span className="text-xs text-red-600 dark:text-red-400">{erro}</span>}
      </div>

      {ultimo && (
        <p className="mt-3 text-xs text-zinc-500">
          Último envio: <span className={STATUS_COR[ultimo.status]}>{ultimo.status}</span>
          {' · '}{quando(ultimo.startedAt)}
          {ultimo.rowCount != null && <> · {ultimo.rowCount.toLocaleString('pt-BR')} linha(s)</>}
          {ultimo.sourceParts != null && <> de {ultimo.sourceParts} parte(s)</>}
          {ultimo.attempts > 1 && <> · {ultimo.attempts} tentativas</>}
          {ultimo.errorMessage && <> · <span className="text-red-600 dark:text-red-400">{ultimo.errorMessage}</span></>}
        </p>
      )}

      {runs.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-500">Histórico ({runs.length})</summary>
          <table className="mt-2 w-full text-xs">
            <thead className="text-zinc-400">
              <tr><th className="py-1 text-left">Quando</th><th className="text-left">Status</th>
                <th className="text-right">Linhas</th><th className="text-right">Partes</th>
                <th className="text-right">Tent.</th><th className="text-left">Erro</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1">{quando(r.startedAt)}</td>
                  <td className={STATUS_COR[r.status]}>{r.status}</td>
                  <td className="text-right">{r.rowCount?.toLocaleString('pt-BR') ?? '—'}</td>
                  <td className="text-right">{r.sourceParts ?? '—'}</td>
                  <td className="text-right">{r.attempts}</td>
                  <td className="max-w-[18rem] truncate text-red-600 dark:text-red-400" title={r.errorMessage ?? ''}>
                    {r.errorMessage ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
