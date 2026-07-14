// Catálogo de Conjuntos de Dados — o usuário só vê nomes amigáveis.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, Search } from 'lucide-react'
import type { DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar o catálogo.'))
  }, [])

  const filtered = datasets?.filter((d) => {
    const q = query.toLowerCase()
    return !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
      || d.tags.some((t) => t.toLowerCase().includes(q))
  })

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Conjuntos de Dados</h1>
      <p className="mt-1 text-sm text-zinc-500">Dados publicados e prontos para explorar.</p>

      <div className="relative mt-6 max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nome, descrição ou tag…"
          className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}
      {datasets === null && !error && <p className="mt-6 text-sm text-zinc-500">Carregando catálogo…</p>}

      {filtered?.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {datasets?.length === 0
            ? 'Nenhum conjunto publicado ainda. Administradores publicam em Administração › Conexões.'
            : 'Nada encontrado para essa busca.'}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {filtered?.map((d) => (
          <Link
            key={d.id}
            to={`/datasets/${d.slug}`}
            className="group rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-accent hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent dark:bg-zinc-800">
                <Boxes size={17} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate font-medium group-hover:text-accent">{d.name}</h2>
                <p className="mt-0.5 line-clamp-2 text-sm text-zinc-500">
                  {d.description || 'Sem descrição.'}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{d.fieldCount} campos</span>
              {d.rowCount !== null && <span>· {d.rowCount.toLocaleString('pt-BR')} registros</span>}
              {d.tags.map((t) => (
                <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">{t}</span>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
