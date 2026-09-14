// Identidade da linha: quais campos dizem que duas linhas são A MESMA linha.
// É o que permite ao incremental ATUALIZAR em vez de acrescentar — sem isto, a
// linha reeditada convive com a versão antiga dela no lake.
//
// Diálogo, e não popover ou lista solta no painel: a lista tem um item por
// campo do conjunto (dezenas, em tabelas largas) e o painel vive dentro de uma
// página que rola, onde um flutuante ancorado é recortado pela borda. Com
// diálogo cabe busca, cabe rolagem própria, e nada corta.
import { useMemo, useState } from 'react'
import { X, Search } from 'lucide-react'
import type { AdminDatasetField } from '@datahub/shared'

export default function DedupeKeysDialog({
  fields, value, onClose, onConfirm,
}: {
  fields: AdminDatasetField[]
  value: string[]
  onClose: () => void
  onConfirm: (keys: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>(value)
  const [busca, setBusca] = useState('')

  const visiveis = useMemo(() => {
    const t = busca.trim().toLowerCase()
    if (!t) return fields
    return fields.filter((f) => f.key.toLowerCase().includes(t) || f.label.toLowerCase().includes(t))
  }, [fields, busca])

  function toggle(key: string) {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Identidade da linha</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Os campos que identificam uma linha de forma única (ex.: <strong>id</strong>). Quando a mesma
          identidade voltar da fonte, a versão mais recente substitui a anterior em vez de virar uma
          segunda linha. Vários campos = identidade composta.
        </p>

        <div className="relative mb-2">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar campo…"
            className={`${inp} pl-8`}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          {visiveis.length === 0 ? (
            <p className="p-3 text-sm text-zinc-500">Nenhum campo com esse nome.</p>
          ) : visiveis.map((f) => (
            <label
              key={f.key}
              className="flex cursor-pointer items-center gap-2 border-b border-zinc-100 px-3 py-2 text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
            >
              <input
                type="checkbox"
                checked={selected.includes(f.key)}
                onChange={() => toggle(f.key)}
                className="accent-accent"
              />
              <span className="min-w-0 flex-1 truncate" title={f.key}>{f.label}</span>
              <span className="shrink-0 text-xs text-zinc-400">{f.type}</span>
            </label>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-zinc-500">
            {selected.length === 0 ? 'Nenhum campo — segue só acrescentando' : `${selected.length} campo(s)`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancelar
            </button>
            <button
              onClick={() => { onConfirm(selected); onClose() }}
              className="rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover"
            >
              Confirmar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
