// Diálogo para editar nome, descrição e personalização global do dashboard
// (paleta padrão + auto-refresh do modo painel). Dono/admin.
import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import type { DashboardSettings } from '@datahub/shared'
import { api } from '@/lib/api'
import { PALETTES, paletteNameOf } from './palettes'

interface Props {
  dashboardId: string
  initialName: string
  initialDescription: string
  initialSettings?: DashboardSettings | null
  onClose: () => void
  onSaved: () => void
}

const REFRESH_OPTIONS: { label: string; value: number }[] = [
  { label: 'Desligado', value: 0 },
  { label: '30 segundos', value: 30 },
  { label: '1 minuto', value: 60 },
  { label: '5 minutos', value: 300 },
  { label: '15 minutos', value: 900 },
]

export default function EditDashboardDialog({ dashboardId, initialName, initialDescription, initialSettings, onClose, onSaved }: Props) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [paletteName, setPaletteName] = useState(paletteNameOf(initialSettings?.palette))
  const [refresh, setRefresh] = useState(initialSettings?.autoRefreshSec ?? 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) { setError('Informe o nome.'); return }
    setSaving(true); setError(null)
    const settings: DashboardSettings = {}
    const pal = PALETTES[paletteName]
    if (pal) settings.palette = pal
    if (refresh > 0) settings.autoRefreshSec = refresh
    try {
      await api(`/api/v1/dashboards/${dashboardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), description: description.trim(), settings }),
      })
      onSaved(); onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.'); setSaving(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Editar dashboard</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inp} autoFocus />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Descrição (opcional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inp} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Paleta padrão</span>
              <select value={paletteName} onChange={(e) => setPaletteName(e.target.value)} className={inp}>
                {Object.keys(PALETTES).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Auto-atualizar (modo TV)</span>
              <select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} className={inp}>
                {REFRESH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={save} disabled={saving}
            className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
