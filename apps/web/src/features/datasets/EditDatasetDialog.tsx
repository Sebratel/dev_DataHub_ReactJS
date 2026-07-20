// Edição rápida dos metadados de um Conjunto de Dados: nome, descrição e tags.
// Vale para fontes e derivados (o SQL do derivado é editado na tela própria).
import { useState } from 'react'
import { X, Loader2, Save } from 'lucide-react'
import { api } from '@/lib/api'

interface Props {
  id: string
  name: string
  description: string
  tags: string[]
  onSaved: () => void
  onClose: () => void
}

export default function EditDatasetDialog({ id, name, description, tags, onSaved, onClose }: Props) {
  const [form, setForm] = useState({ name, description, tags: tags.join(', ') })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!form.name.trim()) { setError('O nome é obrigatório.'); return }
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/datasets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description,
          tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-card-lg dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Editar conjunto</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Nome</span>
          <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950" />
        </label>

        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Descrição</span>
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950" />
        </label>

        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Tags <span className="text-zinc-400">(separadas por vírgula)</span></span>
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="financeiro, mensal, indicadores"
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950" />
        </label>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={busy || !form.name.trim()}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar
          </button>
        </div>
      </div>
    </div>
  )
}
