// Criação/edição de Conjunto DERIVADO: SQL (DuckDB) sobre os conjuntos já
// sincronizados no lake — joins e tratamentos sem tocar nas fontes.
// Rota: /datasets/derived/new (criar) e /datasets/derived/new?slug=x (editar).
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, GitMerge, Loader2, Play, Save } from 'lucide-react'
import type { DatasetSummary, DatasetDetail } from '@datahub/shared'
import { api } from '@/lib/api'

interface PreviewResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

const SQL_PLACEHOLDER = `-- Referencie os conjuntos pelo slug (com aspas) ou pelo apelido com underscore.
-- Exemplo de join com tratamento:
select
  m.status,
  count(*)                as massivas,
  sum(m.affected_clients) as clientes_afetados
from massiva_history m
group by m.status
order by clientes_afetados desc`

export default function DerivedDatasetPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const editSlug = params.get('slug')

  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sql, setSql] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [helperSlug, setHelperSlug] = useState<string | null>(null)
  const [helperFields, setHelperFields] = useState<string[]>([])

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => d.kind === 'source' && d.lastSyncAt)))
      .catch(() => {})
  }, [])

  // Modo edição: carrega o derivado existente.
  useEffect(() => {
    if (!editSlug) return
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${editSlug}`)
      .then(({ dataset }) => {
        setEditingId(dataset.id)
        setName(dataset.name)
        setDescription(dataset.description)
        setSql(dataset.transformSql ?? '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar o conjunto.'))
  }, [editSlug])

  // Ajudante: clique num conjunto → mostra os campos disponíveis.
  useEffect(() => {
    if (!helperSlug) { setHelperFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${helperSlug}`)
      .then((r) => setHelperFields(r.dataset.fields.filter((f) => !f.hidden).map((f) => f.key)))
      .catch(() => setHelperFields([]))
  }, [helperSlug])

  const aliasOf = useMemo(() => (slug: string) => slug.replace(/-/g, '_'), [])

  async function runPreview() {
    setBusy('preview')
    setError(null)
    try {
      setPreview(await api<PreviewResult>('/api/v1/datasets/derived/preview', {
        method: 'POST',
        body: JSON.stringify({ sql }),
      }))
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : 'Falha na pré-visualização.')
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    setBusy('save')
    setError(null)
    try {
      if (editingId) {
        await api(`/api/v1/datasets/derived/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, description, sql }),
        })
        navigate(`/datasets/${editSlug}`)
      } else {
        const r = await api<{ slug: string }>('/api/v1/datasets/derived', {
          method: 'POST',
          body: JSON.stringify({ name, description, sql }),
        })
        navigate(`/datasets/${r.slug}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/datasets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-accent">
        <ArrowLeft size={14} /> Catálogo
      </Link>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent dark:bg-zinc-800">
          <GitMerge size={19} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{editingId ? 'Editar conjunto derivado' : 'Novo conjunto derivado'}</h1>
          <p className="text-sm text-zinc-500">
            Junte e trate conjuntos já sincronizados — roda no lake, sem pesar nas fontes.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Nome (ex.: Relatório de Massivas por Região)</span>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Descrição</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-xs text-zinc-500">SQL (somente SELECT — DuckDB sobre o lake)</span>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder={SQL_PLACEHOLDER}
              rows={14}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>

          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

          <div className="flex gap-2">
            <button onClick={runPreview} disabled={!sql.trim() || busy !== null}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
              {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Pré-visualizar
            </button>
            <button onClick={save} disabled={!name.trim() || !sql.trim() || busy !== null}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {editingId ? 'Salvar e re-materializar' : 'Criar conjunto'}
            </button>
          </div>

          {preview && (
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
                Amostra do resultado ({preview.rows.length} linha{preview.rows.length === 1 ? '' : 's'}, máx. 50)
              </h2>
              <div className="mt-2 max-h-96 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-zinc-950">
                    {preview.rows.map((row, i) => (
                      <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                        {preview.columns.map((c) => (
                          <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-3 py-1.5">
                            {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Ajudante: conjuntos e campos disponíveis */}
        <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400">Conjuntos disponíveis</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Clique para ver os campos. No SQL, use o apelido com underscore ou o slug entre aspas.
          </p>
          <div className="mt-3 space-y-1">
            {datasets.length === 0 && (
              <p className="text-xs text-zinc-500">Nenhum conjunto sincronizado no lake ainda.</p>
            )}
            {datasets.map((d) => (
              <div key={d.id}>
                <button
                  onClick={() => setHelperSlug(helperSlug === d.slug ? null : d.slug)}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <span className="font-mono text-accent">{aliasOf(d.slug)}</span>
                  <span className="ml-1.5 text-zinc-400">{d.rowCount?.toLocaleString('pt-BR') ?? '?'} linhas</span>
                </button>
                {helperSlug === d.slug && (
                  <div className="mb-2 ml-2 flex flex-wrap gap-1">
                    {helperFields.map((f) => (
                      <button
                        key={f}
                        onClick={() => setSql((s) => s + (s.endsWith(' ') || !s ? '' : ' ') + f)}
                        title="Inserir no SQL"
                        className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 hover:bg-accent-soft hover:text-accent dark:bg-zinc-800 dark:text-zinc-400"
                      >
                        {f}
                      </button>
                    ))}
                    {helperFields.length === 0 && <span className="text-[10px] text-zinc-400">carregando…</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
