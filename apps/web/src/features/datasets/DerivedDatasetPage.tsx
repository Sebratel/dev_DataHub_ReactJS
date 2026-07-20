// Criação/edição de Conjunto DERIVADO: SQL (DuckDB) sobre os conjuntos já
// sincronizados no lake — joins e tratamentos sem tocar nas fontes.
// Rota: /datasets/derived/new (criar) e /datasets/derived/new?slug=x (editar).
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, GitMerge, Loader2, Play, Save, Database, ChevronRight, Plus, Info } from 'lucide-react'
import clsx from 'clsx'
import type { DatasetSummary, DatasetDetail } from '@datahub/shared'
import { api } from '@/lib/api'

interface PreviewResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

const SQL_PLACEHOLDER = `-- Referencie os conjuntos pelo apelido (coluna à direita).
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

  // Fontes do lake — sincronizadas primeiro; as não sincronizadas aparecem
  // desabilitadas (é a causa nº1 de "conjunto não disponível" no SQL).
  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(
        r.datasets
          .filter((d) => d.kind === 'source')
          .sort((a, b) => Number(!!b.lastSyncAt) - Number(!!a.lastSyncAt) || a.name.localeCompare(b.name)),
      ))
      .catch(() => {})
  }, [])

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

  useEffect(() => {
    if (!helperSlug) { setHelperFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${helperSlug}`)
      .then((r) => setHelperFields(r.dataset.fields.filter((f) => !f.hidden).map((f) => f.key)))
      .catch(() => setHelperFields([]))
  }, [helperSlug])

  const aliasOf = useMemo(() => (slug: string) => slug.replace(/-/g, '_'), [])
  const insert = (text: string) => setSql((s) => s + (s.endsWith(' ') || s.endsWith('\n') || !s ? '' : ' ') + text)

  async function runPreview() {
    setBusy('preview')
    setError(null)
    try {
      setPreview(await api<PreviewResult>('/api/v1/datasets/derived/preview', {
        method: 'POST', body: JSON.stringify({ sql }),
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
          method: 'PATCH', body: JSON.stringify({ name, description, sql }),
        })
        navigate(`/datasets/${editSlug}`)
      } else {
        const r = await api<{ slug: string }>('/api/v1/datasets/derived', {
          method: 'POST', body: JSON.stringify({ name, description, sql }),
        })
        navigate(`/datasets/${r.slug}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
      setBusy(null)
    }
  }

  const inputCls = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="mx-auto max-w-6xl animate-fade-in">
      <Link to="/datasets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-accent">
        <ArrowLeft size={14} /> Catálogo
      </Link>
      <div className="flex items-center gap-3.5">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-brand text-[#1a1a1a] shadow-card">
          <GitMerge size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{editingId ? 'Editar conjunto derivado' : 'Novo conjunto derivado'}</h1>
          <p className="text-sm text-zinc-500">Junte e trate conjuntos já sincronizados — roda no lake, sem pesar nas fontes.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Formulário */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-zinc-500">Nome</span>
                <input value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Relatório de Massivas por Região" className={inputCls} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-zinc-500">Descrição</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="Opcional" className={inputCls} />
              </label>
            </div>

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500">Consulta SQL</span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-medium text-secondary dark:bg-zinc-800">
                  somente SELECT · DuckDB
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border border-zinc-200 focus-within:border-accent dark:border-zinc-700">
                <textarea value={sql} onChange={(e) => setSql(e.target.value)}
                  placeholder={SQL_PLACEHOLDER} rows={15} spellCheck={false}
                  className="w-full resize-y bg-white px-3 py-2.5 font-mono text-xs leading-relaxed outline-none dark:bg-zinc-950" />
              </div>
            </div>

            {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

            <div className="mt-4 flex gap-2">
              <button onClick={runPreview} disabled={!sql.trim() || busy !== null}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
                {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Pré-visualizar
              </button>
              <button onClick={save} disabled={!name.trim() || !sql.trim() || busy !== null}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 shadow-card hover:bg-accent-hover disabled:opacity-50">
                {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {editingId ? 'Salvar e re-materializar' : 'Criar conjunto'}
              </button>
            </div>
          </div>

          {preview && (
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
                Amostra do resultado ({preview.rows.length} linha{preview.rows.length === 1 ? '' : 's'}, máx. 50)
              </h2>
              <div className="mt-2 max-h-96 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                    <tr>{preview.columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>)}</tr>
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
        <aside className="h-fit rounded-2xl border border-zinc-200 bg-white p-4 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Conjuntos disponíveis</h2>
          <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500">
            <Info size={13} className="mt-0.5 shrink-0" />
            No SQL, use o <b className="font-semibold text-secondary">apelido</b> (não o nome). Clique para inserir.
          </p>

          <div className="mt-3 space-y-0.5">
            {datasets.length === 0 && <p className="text-xs text-zinc-500">Nenhuma fonte publicada ainda.</p>}
            {datasets.map((d) => {
              const synced = !!d.lastSyncAt
              const alias = aliasOf(d.slug)
              const open = helperSlug === d.slug
              return (
                <div key={d.id} className="rounded-lg">
                  <button
                    onClick={() => synced && setHelperSlug(open ? null : d.slug)}
                    disabled={!synced}
                    className={clsx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                      synced ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'cursor-not-allowed opacity-60')}>
                    <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', synced ? 'bg-emerald-500' : 'bg-amber-500')} />
                    <Database size={13} className="shrink-0 text-zinc-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{d.name}</span>
                      <span className="block truncate font-mono text-[10px] text-accent">{alias}</span>
                    </span>
                    {synced
                      ? <ChevronRight size={13} className={clsx('shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} />
                      : <span className="shrink-0 text-[9px] font-medium uppercase text-amber-600 dark:text-amber-500">sincronize</span>}
                  </button>

                  {open && synced && (
                    <div className="mb-2 ml-4 border-l border-zinc-100 pl-3 dark:border-zinc-800">
                      <button onClick={() => insert(alias)}
                        className="mt-1 inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-secondary hover:bg-accent hover:text-[#1a1a1a] dark:bg-zinc-800">
                        <Plus size={10} /> {alias}
                      </button>
                      <p className="mt-1.5 text-[10px] text-zinc-400">Campos:</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {helperFields.map((f) => (
                          <button key={f} onClick={() => insert(f)} title="Inserir campo no SQL"
                            className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 hover:bg-accent-soft hover:text-accent dark:bg-zinc-800 dark:text-zinc-400">
                            {f}
                          </button>
                        ))}
                        {helperFields.length === 0 && <span className="text-[10px] text-zinc-400">carregando…</span>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}
