// O notebook em si: células, execução e a ponte para o catálogo.
//
// Três decisões que moldam a tela:
//  1. Cada célula guarda o próprio resultado em MEMÓRIA, nunca no banco.
//     Resultado envelhece e pode conter dado sensível de um conjunto que quem
//     abrir depois não alcança. Guarda-se o SQL; reexecutar é barato.
//  2. Salvamento é automático e silencioso (debounce), como todo notebook —
//     mas o indicador diz em que estado está, para ninguém fechar a aba na
//     dúvida.
//  3. "Materializar" é o botão que diferencia isto de um cliente SQL: leva a
//     exploração para dentro da governança (linhagem, permissão, atualização).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  Play, Plus, Trash2, ArrowLeft, Loader2, AlertTriangle, Database,
  Boxes, ChevronDown, ChevronRight, Type, Table2, Check, Lock, Users, Download,
  Braces, Square, Share2, Trash, FastForward, Minimize2, Maximize2,
} from 'lucide-react'
import type {
  Notebook, NotebookCell, NotebookCatalogEntry, NotebookRunResult,
} from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'
import { useAuthStore } from '@/store/authStore'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td } from '@/components/ui/DataGrid'
import ShareNotebookDialog from './ShareNotebookDialog'
import SqlEditor from './SqlEditor'
import Markdown from './markdown'
import { usePython, type PythonResult } from './usePython'

interface CellState {
  running: boolean
  result: NotebookRunResult | null
  error: string | null
  /** Saída da célula Python (stdout + valor da última expressão). */
  python?: PythonResult | null
}

const newId = () => `c${Math.random().toString(36).slice(2, 9)}`

// O contrato da célula Python em duas linhas: `df` já vem pronto da célula SQL
// acima. É o que evita a pergunta "como eu pego os dados aqui dentro?".
const PY_PLACEHOLDER = [
  '# df traz o resultado da célula SQL acima (pandas.DataFrame)',
  'print(df.describe())',
].join('\n')

export default function NotebookPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const myEmail = useAuthStore((s) => s.user)?.email
  const amAdmin = !!useAuthStore((s) => s.user)?.roles?.includes('admin')
  const [nb, setNb] = useState<Notebook | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [catalog, setCatalog] = useState<NotebookCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<Record<string, CellState>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [editingMd, setEditingMd] = useState<Record<string, boolean>>({})
  const [materializing, setMaterializing] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [runningAll, setRunningAll] = useState<{ done: number; total: number } | null>(null)
  const [runAllError, setRunAllError] = useState<string | null>(null)
  // Recolhimento LOCAL, que vence o persistido. Existe para quem só lê poder
  // abrir uma célula recolhida sem conseguir (nem dever) gravar nada.
  const [collapsedLocal, setCollapsedLocal] = useState<Record<string, boolean>>({})

  const python = usePython()
  const abortAll = useRef<AbortController | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  // Ref com o valor corrente: o debounce dispara depois, e ler o estado
  // capturado no closure salvaria uma versão velha.
  const latest = useRef<Notebook | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [n, c] = await Promise.all([
          api<{ notebook: Notebook; canEdit: boolean }>(`/api/v1/notebooks/${slug}`),
          api<{ datasets: NotebookCatalogEntry[] }>('/api/v1/notebooks/catalog'),
        ])
        if (!alive) return
        setNb(n.notebook)
        latest.current = n.notebook
        setCanEdit(n.canEdit)
        setCatalog(c.datasets)
      } catch (e) {
        if (alive) setError((e as ApiError).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [slug])

  const scheduleSave = useCallback(() => {
    if (!canEdit) return
    clearTimeout(saveTimer.current)
    setSaveState('saving')
    saveTimer.current = setTimeout(() => {
      const cur = latest.current
      if (!cur) return
      void api(`/api/v1/notebooks/${slug}`, {
        method: 'PUT',
        body: JSON.stringify({ name: cur.name, description: cur.description, cells: cur.cells, visibility: cur.visibility }),
      }).then(() => setSaveState('saved')).catch(() => setSaveState('error'))
    }, 900)
  }, [slug, canEdit])

  function update(patch: Partial<Notebook>) {
    setNb((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      latest.current = next
      return next
    })
    scheduleSave()
  }

  const setCells = (cells: NotebookCell[]) => update({ cells })

  function patchCell(id: string, patch: Partial<NotebookCell>) {
    if (!nb) return
    setCells(nb.cells.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function addCell(kind: NotebookCell['kind'], after?: string) {
    if (!nb) return
    const cell: NotebookCell = { id: newId(), kind, source: '' }
    const i = after ? nb.cells.findIndex((c) => c.id === after) + 1 : nb.cells.length
    const next = [...nb.cells]
    next.splice(i, 0, cell)
    setCells(next)
    if (kind === 'markdown') setEditingMd((s) => ({ ...s, [cell.id]: true }))
  }

  // ── Recolher ───────────────────────────────────────────────────────────
  const recolhida = (c: NotebookCell) => collapsedLocal[c.id] ?? !!c.collapsed

  function alternaRecolhida(c: NotebookCell) {
    const next = !recolhida(c)
    setCollapsedLocal((s) => ({ ...s, [c.id]: next }))
    if (canEdit) patchCell(c.id, { collapsed: next })
  }

  function recolheTodas(valor: boolean) {
    if (!nb) return
    setCollapsedLocal(Object.fromEntries(nb.cells.map((c) => [c.id, valor])))
    if (canEdit) setCells(nb.cells.map((c) => ({ ...c, collapsed: valor })))
  }

  // O que mostrar no lugar do conteúdo recolhido: a primeira linha que diz
  // alguma coisa. Pular comentário importa — uma query boa começa com um
  // cabeçalho de comentário, e "-- =====" não identifica célula nenhuma.
  //
  // Em markdown é o contrário: ali "#" é TÍTULO, e título é exatamente o
  // melhor resumo possível. Só o cerquilha sai, para não virar ruído.
  function resumo(kind: NotebookCell['kind'], source: string): string {
    const linhas = source.split('\n').map((l) => l.trim())
    const linha = kind === 'markdown'
      ? linhas.find(Boolean)?.replace(/^#+\s*/, '')
      : linhas.find((l) => l && !l.startsWith('--') && !l.startsWith('#'))
    return linha ? (linha.length > 90 ? `${linha.slice(0, 90)}…` : linha) : '(vazia)'
  }

  function removeCell(id: string) {
    if (!nb) return
    setCells(nb.cells.filter((c) => c.id !== id))
    setState((s) => { const { [id]: _drop, ...rest } = s; return rest })
  }

  // Devolve o resultado além de guardá-lo no estado. O "executar tudo" precisa
  // do valor AGORA: o setState só aparece no próximo render, e a célula Python
  // seguinte receberia o `df` da execução anterior — erro que não dá erro.
  async function run(cell: NotebookCell, signal?: AbortSignal): Promise<NotebookRunResult | null> {
    setState((s) => ({ ...s, [cell.id]: { running: true, result: null, error: null } }))
    try {
      const r = await api<NotebookRunResult>('/api/v1/notebooks/run', {
        method: 'POST',
        body: JSON.stringify({ sql: cell.source, limit: 500 }),
        signal,
      })
      setState((s) => ({ ...s, [cell.id]: { running: false, result: r, error: null } }))
      return r
    } catch (e) {
      // Cancelamento não é falha da célula: quem parou foi a pessoa.
      if ((e as Error).name === 'AbortError') {
        setState((s) => ({ ...s, [cell.id]: { running: false, result: null, error: null } }))
        return null
      }
      setState((s) => ({ ...s, [cell.id]: { running: false, result: null, error: (e as ApiError).message } }))
      return null
    }
  }

  // A célula Python recebe o resultado da célula SQL EXECUTADA mais próxima
  // acima dela — o mesmo modelo do BigQuery: o SQL roda no motor, o Python roda
  // sobre o resultado. Sem isso a pessoa teria que colar dados no código.
  function upstreamData(cellId: string): NotebookRunResult | null {
    if (!nb) return null
    const idx = nb.cells.findIndex((c) => c.id === cellId)
    for (let i = idx - 1; i >= 0; i--) {
      const c = nb.cells[i]
      if (c.kind !== 'sql') continue
      const r = state[c.id]?.result
      if (r) return r
    }
    return null
  }

  // `upstream` explícito vem do "executar tudo", que acabou de rodar o SQL e
  // tem o resultado em mãos. Sem ele, cai na busca pelo estado — o caminho de
  // quem clicou Executar nesta célula sozinha.
  async function runPython(
    cell: NotebookCell, upstream?: NotebookRunResult | null,
  ): Promise<PythonResult> {
    const data = upstream !== undefined ? upstream : upstreamData(cell.id)
    setState((s) => ({ ...s, [cell.id]: { running: true, result: null, error: null, python: null } }))
    const r = await python.run(cell.source, data ? { columns: data.columns, rows: data.rows } : null)
    setState((s) => ({ ...s, [cell.id]: { running: false, result: null, error: null, python: r } }))
    return r
  }

  // ── Executar tudo ──────────────────────────────────────────────────────
  // Em SÉRIE e de cima para baixo, porque é essa a semântica de um notebook:
  // a célula Python lê o resultado da SQL acima dela. Em paralelo seria mais
  // rápido e daria a resposta errada.
  //
  // PARA no primeiro erro. Seguir adiante produziria números que parecem
  // válidos — a célula Python rodaria sobre o `df` da passada anterior, e
  // ninguém olha o meio de um notebook para conferir se ele realmente rodou.
  async function runAll() {
    if (!nb) return
    const fila = nb.cells.filter((c) => c.kind !== 'markdown' && c.source.trim())
    if (!fila.length) return

    const ctrl = new AbortController()
    abortAll.current = ctrl
    setRunAllError(null)
    setRunningAll({ done: 0, total: fila.length })
    // Último resultado SQL DESTA passada, passado adiante na mão.
    let ultimoSql: NotebookRunResult | null = null
    let concluiu = false
    // Quem falhou é ABERTO na hora. O erro é renderizado fora da parte
    // recolhida, mas uma célula fechada no meio de dez não é encontrada por
    // um aviso que diz só "célula 7".
    const falhou = (cell: NotebookCell, pos: number, tipo: string) => {
      setCollapsedLocal((s) => ({ ...s, [cell.id]: false }))
      setRunAllError(`Parou na célula ${pos} (${tipo}) — o erro está nela, logo abaixo do código.`)
      setRunningAll(null)
    }
    try {
      for (let i = 0; i < fila.length; i++) {
        if (ctrl.signal.aborted) return
        const cell = fila[i]
        setRunningAll({ done: i, total: fila.length })
        const pos = nb.cells.findIndex((c) => c.id === cell.id) + 1
        if (cell.kind === 'sql') {
          const r = await run(cell, ctrl.signal)
          if (ctrl.signal.aborted) return
          if (!r) { falhou(cell, pos, 'SQL'); return }
          ultimoSql = r
        } else {
          const r = await runPython(cell, ultimoSql)
          if (ctrl.signal.aborted) return
          if (r.error) { falhou(cell, pos, 'Python'); return }
        }
      }
      concluiu = true
      setRunningAll({ done: fila.length, total: fila.length })
    } finally {
      abortAll.current = null
      // Só no sucesso: deixa o "7 de 7" na tela por um instante, porque sumir
      // no mesmo quadro em que termina faz parecer que não rodou. Na falha o
      // contador já foi zerado, e deixá-lo girando seria mentira.
      if (concluiu) setTimeout(() => setRunningAll(null), 1200)
    }
  }

  function pararTudo() {
    abortAll.current?.abort()
    python.cancel()
    setRunningAll(null)
    setRunAllError('Execução interrompida.')
  }

  async function materialize(cell: NotebookCell) {
    const name = window.prompt('Nome do conjunto a criar a partir desta célula:')
    if (!name?.trim()) return
    setMaterializing(cell.id)
    try {
      const r = await api<{ slug: string }>('/api/v1/notebooks/materialize', {
        method: 'POST',
        body: JSON.stringify({ sql: cell.source, name: name.trim() }),
      })
      setState((s) => ({
        ...s,
        [cell.id]: { running: false, result: s[cell.id]?.result ?? null, error: null },
      }))
      window.open(`/datasets/${r.slug}`, '_blank')
    } catch (e) {
      setState((s) => ({ ...s, [cell.id]: { running: false, result: null, error: (e as ApiError).message } }))
    } finally {
      setMaterializing(null)
    }
  }

  function exportCsv(cell: NotebookCell, result: NotebookRunResult) {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [result.columns.join(';'), ...result.rows.map((r) => result.columns.map((c) => esc(r[c])).join(';'))].join('\r\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug}-${cell.id}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="mx-auto min-w-0 max-w-[1600px]"><div className="h-[420px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" /></div>
  }
  if (!nb) {
    return (
      <div className="mx-auto min-w-0 max-w-[1600px]">
        <p className="text-[12px] text-zinc-500">{error ?? 'Notebook não encontrado.'}</p>
        <Link to="/notebooks" className="mt-2 inline-block text-[12px] font-medium text-info hover:underline dark:text-info-dark">Voltar</Link>
      </div>
    )
  }

  async function removeNotebook() {
    if (!nb) return
    const ok = await confirm({
      title: 'Excluir notebook',
      message: `"${nb.name}" e todas as suas células serão apagados. Conjuntos já materializados a partir dele continuam existindo. Não dá para desfazer.`,
      confirmLabel: 'Excluir',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      await api(`/api/v1/notebooks/${slug}`, { method: 'DELETE' })
      navigate('/notebooks')
    } catch (e) {
      setError((e as ApiError).message)
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1600px]">
      <Link to="/notebooks" className="inline-flex items-center gap-1 text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={12} strokeWidth={1.8} /> Notebooks
      </Link>

      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <input
          value={nb.name}
          onChange={(e) => update({ name: e.target.value })}
          readOnly={!canEdit}
          className="min-w-0 flex-1 border-none bg-transparent text-[17px] font-semibold tracking-tight outline-none focus:ring-0"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Executar tudo vem ANTES dos controles de notebook: é a ação que
              mais se repete quando se volta a uma análise de ontem. */}
          {runningAll ? (
            <>
              <span className="flex items-center gap-1 text-[10.5px] tabular-nums text-zinc-500">
                <Loader2 size={10} className="animate-spin" />
                célula {Math.min(runningAll.done + 1, runningAll.total)} de {runningAll.total}
              </span>
              <button
                onClick={pararTudo}
                className="flex items-center gap-1.5 rounded-lg border border-crit/40 px-2.5 py-1.5 text-[11.5px] font-medium text-crit transition-colors hover:bg-crit-soft dark:text-crit-dark"
              >
                <Square size={11} strokeWidth={2.4} /> Parar
              </button>
            </>
          ) : (
            <button
              onClick={() => void runAll()}
              disabled={!nb.cells.some((c) => c.kind !== 'markdown' && c.source.trim())}
              title="Executa as células SQL e Python de cima para baixo, em série"
              className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <FastForward size={12} strokeWidth={2.2} /> Executar tudo
            </button>
          )}
          {nb.cells.length > 1 && (
            <button
              onClick={() => recolheTodas(!nb.cells.every((c) => recolhida(c)))}
              title={nb.cells.every((c) => recolhida(c)) ? 'Expandir todas as células' : 'Recolher todas as células'}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300"
            >
              {nb.cells.every((c) => recolhida(c))
                ? <><Maximize2 size={11} /> Expandir</>
                : <><Minimize2 size={11} /> Recolher</>}
            </button>
          )}
          {saveState === 'saving' && <span className="flex items-center gap-1 text-[10.5px] text-zinc-400"><Loader2 size={10} className="animate-spin" /> salvando</span>}
          {saveState === 'saved' && <span className="flex items-center gap-1 text-[10.5px] text-zinc-400"><Check size={10} /> salvo</span>}
          {saveState === 'error' && <Pill tone="crit">falha ao salvar</Pill>}
          {!canEdit && <Pill>somente leitura</Pill>}
          {canEdit && (
            <button
              onClick={() => update({ visibility: nb.visibility === 'tenant' ? 'private' : 'tenant' })}
              title={nb.visibility === 'tenant' ? 'Visível para todo o time' : 'Só você'}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300"
            >
              {nb.visibility === 'tenant' ? <Users size={12} /> : <Lock size={12} />}
              {nb.visibility === 'tenant' ? 'Time' : 'Privado'}
            </button>
          )}
          {/* Excluir mora aqui TAMBÉM, não só na lista: quem acabou de decidir
              que a análise não presta está com ela aberta na frente, não
              procurando a linha certa numa tabela. */}
          {nb.owner_email === myEmail || amAdmin ? (
            <button
              onClick={() => void removeNotebook()}
              disabled={deleting}
              title="Excluir notebook"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-crit/50 hover:text-crit disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-crit-dark"
            >
              {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash size={12} strokeWidth={1.6} />}
              Excluir
            </button>
          ) : null}
          {/* Aberto a quem só lê também: saber quem mais enxerga esta análise
              é parte de decidir o que escrever nela. */}
          <button
            onClick={() => setSharing(true)}
            title="Gerenciar acessos"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300"
          >
            <Share2 size={12} strokeWidth={1.6} /> Acessos
          </button>
        </div>
      </div>

      {sharing && (
        <ShareNotebookDialog
          slug={slug}
          onClose={() => setSharing(false)}
          onVisibility={(v) => setNb((cur) => (cur ? { ...cur, visibility: v } : cur))}
        />
      )}

      {/* Onde a execução em lote parou. A célula em si mostra o erro completo;
          aqui fica só o ponteiro, porque com o código recolhido a pessoa pode
          nem estar vendo a célula que falhou. */}
      {runAllError && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 dark:bg-warn/10">
          <AlertTriangle size={13} className="mt-px shrink-0 text-warn dark:text-warn-dark" />
          <p className="flex-1 text-[11.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">{runAllError}</p>
          <button onClick={() => setRunAllError(null)} className="shrink-0 text-[10.5px] text-zinc-500 hover:underline">
            fechar
          </button>
        </div>
      )}

      <div className="mt-3 grid items-start gap-2.5 xl:grid-cols-[minmax(0,1fr)_268px]">
        {/* Células */}
        <div className="flex min-w-0 flex-col gap-2.5">
          {nb.cells.map((cell) => {
            const st = state[cell.id]
            const fechada = recolhida(cell)
            const linhas = cell.source ? cell.source.split('\n').length : 0
            return (
              <Card key={cell.id}>
                <CardHead
                  icon={cell.kind === 'markdown' ? Type : cell.kind === 'python' ? Braces : Table2}
                  title={cell.kind === 'markdown' ? 'Texto' : cell.kind === 'python' ? 'Python' : 'SQL'}
                  sub={
                    st?.result ? `${st.result.rows.length} linha(s) · ${st.result.ms} ms`
                      : cell.kind === 'python' ? (upstreamData(cell.id) ? 'df da célula SQL acima' : 'sem dados acima')
                      : undefined
                  }
                  // Recolher fica junto do título, onde todo editor o põe —
                  // não no meio dos botões de ação. Com 200 linhas de SQL,
                  // chegar nas células de baixo é o atrito mais frequente.
                  lead={
                    <button
                      onClick={() => alternaRecolhida(cell)}
                      title={fechada ? 'Expandir' : `Recolher (${linhas} linha(s))`}
                      className="-ml-1 flex shrink-0 items-center gap-1 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      {fechada ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      {fechada && linhas > 1 && (
                        <span className="text-[10px] tabular-nums">{linhas}</span>
                      )}
                    </button>
                  }
                >
                  {cell.kind === 'python' && (
                    st?.running ? (
                      <button onClick={python.cancel}
                        className="flex items-center gap-1 rounded-lg border border-crit/40 px-2.5 py-1 text-[10.5px] font-semibold text-crit transition-colors hover:bg-crit-soft dark:text-crit-dark">
                        <Square size={10} strokeWidth={2.4} /> Parar
                      </button>
                    ) : (
                      <button onClick={() => void runPython(cell)} disabled={!cell.source.trim()}
                        className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
                        <Play size={11} strokeWidth={2.2} /> Executar
                      </button>
                    )
                  )}
                  {cell.kind === 'sql' && (
                    <>
                      {st?.result && st.result.rows.length > 0 && (
                        <button onClick={() => exportCsv(cell, st.result!)} title="Exportar CSV"
                          className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800">
                          <Download size={13} />
                        </button>
                      )}
                      {canEdit && st?.result && (
                        <button onClick={() => void materialize(cell)} disabled={materializing === cell.id}
                          className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[10.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                          {materializing === cell.id ? <Loader2 size={11} className="animate-spin" /> : <Boxes size={11} />}
                          Materializar
                        </button>
                      )}
                      <button onClick={() => void run(cell)} disabled={st?.running || !cell.source.trim()}
                        className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[10.5px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
                        {st?.running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} strokeWidth={2.2} />}
                        Executar
                      </button>
                    </>
                  )}
                  {cell.kind === 'markdown' && canEdit && (
                    <button onClick={() => setEditingMd((s) => ({ ...s, [cell.id]: !s[cell.id] }))}
                      className="text-[10.5px] font-medium text-info hover:underline dark:text-info-dark">
                      {editingMd[cell.id] ? 'Visualizar' : 'Editar'}
                    </button>
                  )}
                  {canEdit && (
                    <button onClick={() => removeCell(cell.id)} title="Remover célula"
                      className="rounded p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit dark:hover:bg-crit/15">
                      <Trash2 size={13} />
                    </button>
                  )}
                </CardHead>

                {fechada ? (
                  // O resumo é clicável: recolher sem jeito de voltar a abrir
                  // pelo próprio corpo obrigaria a mirar no chevron.
                  <button
                    onClick={() => alternaRecolhida(cell)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500">
                      {resumo(cell.kind, cell.source)}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-400">expandir</span>
                  </button>
                ) : cell.kind === 'python' ? (
                  <textarea
                    value={cell.source}
                    readOnly={!canEdit}
                    onChange={(e) => patchCell(cell.id, { source: e.target.value })}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void runPython(cell) }
                    }}
                    spellCheck={false}
                    placeholder={PY_PLACEHOLDER}
                    className="min-h-[96px] w-full resize-y border-none bg-transparent px-3 py-2 font-mono text-[11.5px] leading-relaxed outline-none focus:ring-0"
                  />
                ) : cell.kind === 'sql' ? (
                  <SqlEditor
                    value={cell.source}
                    readOnly={!canEdit}
                    onChange={(v) => patchCell(cell.id, { source: v })}
                    onRun={() => void run(cell)}
                  />
                ) : editingMd[cell.id] ? (
                  <textarea
                    value={cell.source}
                    onChange={(e) => patchCell(cell.id, { source: e.target.value })}
                    placeholder="Explique o que esta parte da análise mostra…"
                    className="min-h-[84px] w-full resize-y border-none bg-transparent px-3 py-2 font-mono text-[11.5px] leading-relaxed outline-none focus:ring-0"
                  />
                ) : (
                  <div className="px-3 py-2">
                    {cell.source.trim()
                      ? <Markdown source={cell.source} />
                      : <p className="text-[11.5px] italic text-zinc-400">Célula de texto vazia.</p>}
                  </div>
                )}

                {cell.kind === 'python' && st?.running && python.status && (
                  <p className="flex items-center gap-1.5 border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
                    <Loader2 size={11} className="animate-spin" /> {python.status}
                  </p>
                )}

                {st?.python && (
                  <div className="border-t border-zinc-200 dark:border-zinc-800">
                    {st.python.stdout && (
                      <pre className="m-0 max-h-[300px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                        {st.python.stdout}
                      </pre>
                    )}
                    {st.python.repr && (
                      <pre className="m-0 max-h-[300px] overflow-auto whitespace-pre-wrap border-t border-zinc-200 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                        {st.python.repr}
                      </pre>
                    )}
                    {st.python.error && (
                      <pre className="m-0 max-h-[300px] overflow-auto whitespace-pre-wrap bg-crit-soft px-3 py-2 font-mono text-[11px] leading-relaxed text-crit dark:bg-crit/10 dark:text-crit-dark">
                        {st.python.error}
                      </pre>
                    )}
                    {!st.python.stdout && !st.python.repr && !st.python.error && (
                      <p className="px-3 py-2 text-[11.5px] text-zinc-500">Executou sem saída.</p>
                    )}
                  </div>
                )}

                {st?.error && (
                  <div className="flex items-start gap-2 border-t border-zinc-200 bg-crit-soft px-3 py-2 dark:border-zinc-800 dark:bg-crit/10">
                    <AlertTriangle size={13} className="mt-px shrink-0 text-crit dark:text-crit-dark" />
                    <p className="text-[11.5px] leading-relaxed text-crit dark:text-crit-dark">{st.error}</p>
                  </div>
                )}

                {st?.result && (
                  st.result.rows.length === 0 ? (
                    <p className="border-t border-zinc-200 px-3 py-3 text-center text-[11.5px] text-zinc-500 dark:border-zinc-800">
                      A consulta rodou e não retornou linhas.
                    </p>
                  ) : (
                    <div className="border-t border-zinc-200 dark:border-zinc-800">
                      <div className="max-h-[360px] overflow-auto">
                        <DataGrid>
                          <thead className="sticky top-0 z-10">
                            <tr>{st.result.columns.map((c) => <Th key={c}>{c}</Th>)}</tr>
                          </thead>
                          <tbody>
                            {st.result.rows.slice(0, 200).map((row, i) => (
                              <Tr key={i}>
                                {st.result!.columns.map((c) => (
                                  <Td key={c} muted>{row[c] === null || row[c] === undefined ? '—' : String(row[c])}</Td>
                                ))}
                              </Tr>
                            ))}
                          </tbody>
                        </DataGrid>
                      </div>
                      <p className="border-t border-zinc-200 px-3 py-1.5 text-[10.5px] text-zinc-400 dark:border-zinc-800">
                        {st.result.rows.length > 200 && `mostrando 200 de ${st.result.rows.length} · `}
                        {st.result.truncated && 'resultado cortado no limite de 500 linhas — refine com filtros ou agregue · '}
                        {st.result.ms} ms
                      </p>
                    </div>
                  )
                )}
              </Card>
            )
          })}

          {canEdit && (
            <div className="flex items-center gap-2">
              <button onClick={() => addCell('sql')}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-[11.5px] font-medium text-zinc-500 transition-colors hover:border-accent hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-100">
                <Plus size={13} strokeWidth={2} /> Célula SQL
              </button>
              <button onClick={() => addCell('python')}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-[11.5px] font-medium text-zinc-500 transition-colors hover:border-accent hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-100">
                <Braces size={13} strokeWidth={2} /> Célula Python
              </button>
              <button onClick={() => addCell('markdown')}
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-[11.5px] font-medium text-zinc-500 transition-colors hover:border-accent hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-100">
                <Type size={13} strokeWidth={2} /> Célula de texto
              </button>
              <span className="text-[10.5px] text-zinc-400">Ctrl/⌘ + Enter executa a célula</span>
            </div>
          )}
        </div>

        {/* Catálogo lateral */}
        <div className="flex min-w-0 flex-col gap-2.5">
          <Card>
            <CardHead icon={Database} title="Conjuntos disponíveis" sub={`${catalog.length}`} />
            <p className="border-b border-zinc-200 px-3 py-2 text-[10.5px] leading-snug text-zinc-500 dark:border-zinc-800">
              Escreva o nome com <b>underscore</b> no SQL. Só aparecem aqui os conjuntos que você pode ler.
            </p>
            <div className="max-h-[520px] overflow-y-auto">
              {catalog.length === 0 ? (
                <p className="px-3 py-5 text-center text-[11.5px] text-zinc-500">
                  Nenhum conjunto sincronizado ao qual você tenha acesso.
                </p>
              ) : catalog.map((d) => <CatalogItem key={d.slug} entry={d} />)}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

// Item do catálogo: expande para mostrar as colunas, carregadas sob demanda —
// buscar campo de 200 conjuntos no load da página seria desperdício.
function CatalogItem({ entry }: { entry: NotebookCatalogEntry }) {
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState<{ key: string; type: string }[] | null>(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && !fields) {
      try {
        const r = await api<{ fields: { key: string; type: string }[] }>(
          `/api/v1/notebooks/catalog/${entry.slug}/fields`,
        )
        setFields(r.fields)
      } catch {
        setFields([])
      }
    }
  }

  return (
    <div className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <button onClick={() => void toggle()}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
        {open ? <ChevronDown size={12} className="shrink-0 text-zinc-400" /> : <ChevronRight size={12} className="shrink-0 text-zinc-400" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{entry.alias}</span>
          <span className="block truncate text-[10px] text-zinc-400">{entry.name}</span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">
          {entry.rowCount !== null ? entry.rowCount.toLocaleString('pt-BR') : `${entry.fieldCount} col`}
        </span>
      </button>
      {open && (
        <div className="bg-zinc-50 px-3 py-1.5 dark:bg-zinc-950/40">
          {fields === null ? (
            <p className="text-[10.5px] text-zinc-400">carregando…</p>
          ) : fields.length === 0 ? (
            <p className="text-[10.5px] text-zinc-400">sem colunas visíveis</p>
          ) : fields.map((f) => (
            <div key={f.key} className="flex items-baseline gap-2 py-px">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600 dark:text-zinc-400">{f.key}</span>
              <span className="shrink-0 text-[9px] uppercase tracking-wider text-zinc-400">{f.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
