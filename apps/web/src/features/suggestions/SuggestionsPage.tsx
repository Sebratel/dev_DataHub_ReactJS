// Sugestões de melhoria do Data Hub (item 2 de 19/11/2026) — as MESMAS do Hub
// Apps e dos outros sistemas (banco DB_Hub_Apps), filtradas pelo app do Data
// Hub. Como no Splitters: em "somente leitura" (padrão) a tela mostra e manda
// sugerir/votar/comentar no Hub Apps; liberada, faz tudo aqui. Status é do admin.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lightbulb, ThumbsUp, ThumbsDown, MessageSquare, ExternalLink, Plus, Loader2, X, Send } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { Page, PageHeader, ErrorBanner, TableSkeleton, PrimaryButton, EmptyState } from '@/components/ui/Page'

type Status = 'open' | 'planned' | 'in_progress' | 'done' | 'rejected'
interface Pessoa { email: string; name: string; photoURL: string | null }
interface Comentario { id: number; author: Pessoa; message: string; createdAt: string | null }
interface Sugestao {
  id: number; title: string; description: string; sector: string; category: string | null
  status: Status; author: Pessoa
  likesCount: number; dislikesCount: number; commentsCount: number; score: number
  viewerVote: 'like' | 'dislike' | null
  supporters: Pessoa[]; comments: Comentario[]
  createdAt: string | null
}
interface Meta { readOnly: boolean; appId: string | null; hubAppsUrl: string; missing: string[]; statuses: Status[] }

const STATUS: Record<Status, { rotulo: string; cor: string }> = {
  open: { rotulo: 'Aberta', cor: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
  planned: { rotulo: 'Planejada', cor: 'bg-info-soft text-info dark:bg-info/15 dark:text-info-dark' },
  in_progress: { rotulo: 'Em andamento', cor: 'bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark' },
  done: { rotulo: 'Concluída', cor: 'bg-ok-soft text-ok dark:bg-ok/15 dark:text-ok-dark' },
  rejected: { rotulo: 'Recusada', cor: 'bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark' },
}
const quando = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '')

function Avatar({ p, size = 20 }: { p: Pessoa; size?: number }) {
  const iniciais = (p.name || p.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()
  return p.photoURL
    ? <img src={p.photoURL} alt="" title={p.name} referrerPolicy="no-referrer" className="rounded-full" style={{ width: size, height: size }} />
    : <span title={p.name} className="flex items-center justify-center rounded-full bg-zinc-200 text-[9px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200" style={{ width: size, height: size }}>{iniciais}</span>
}

export default function SuggestionsPage() {
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  const [lista, setLista] = useState<Sugestao[] | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Status | 'todas'>('todas')
  const [nova, setNova] = useState(false)
  const [aberta, setAberta] = useState<number | null>(null)

  const load = useCallback(() => {
    api<{ suggestions: Sugestao[]; meta: Meta }>('/api/v1/suggestions')
      .then((r) => { setLista(r.suggestions); setMeta(r.meta) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar as sugestões.'))
  }, [])
  useEffect(load, [load])

  const troca = (s: Sugestao) => setLista((l) => (l ?? []).map((x) => (x.id === s.id ? s : x)))
  const escreve = !!meta && !meta.readOnly && meta.missing.length === 0

  async function votar(s: Sugestao, tipo: 'like' | 'dislike') {
    try {
      troca((await api<{ suggestion: Sugestao }>(`/api/v1/suggestions/${s.id}/vote`, { method: 'POST', body: JSON.stringify({ voteType: tipo }) })).suggestion)
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao votar.') }
  }
  async function status(s: Sugestao, st: Status) {
    try {
      troca((await api<{ suggestion: Sugestao }>(`/api/v1/suggestions/${s.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: st }) })).suggestion)
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao mudar o status.') }
  }

  const contagem = useMemo(() => {
    const c: Record<string, number> = { todas: lista?.length ?? 0 }
    for (const s of lista ?? []) c[s.status] = (c[s.status] ?? 0) + 1
    return c
  }, [lista])
  const visiveis = (lista ?? []).filter((s) => filtro === 'todas' || s.status === filtro)

  return (
    <Page>
      <PageHeader
        icon={Lightbulb}
        title="Sugestões de melhoria"
        subtitle="As mesmas do Hub Apps: o que as pessoas pedem para o Data Hub, com votos e comentários."
      >
        {meta && meta.missing.length === 0 && (escreve
          ? !nova && <PrimaryButton icon={Plus} onClick={() => setNova(true)}>Nova sugestão</PrimaryButton>
          : (
            <a href={meta.hubAppsUrl} target="_blank" rel="noopener noreferrer"
              className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-zinc-950 hover:bg-accent-hover">
              <ExternalLink size={14} /> Sugerir no Hub Apps
            </a>
          ))}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {meta && meta.missing.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-[12px] text-zinc-700 dark:bg-warn/10 dark:text-zinc-300">
          <b>O módulo de sugestões ainda não foi ligado.</b>{' '}
          {isAdmin
            ? <>Falta configurar na stack: <span className="font-mono">{meta.missing.join(', ')}</span>. O id do app vem do cadastro do Data Hub no Hub Apps.</>
            : <>Enquanto isso, as sugestões podem ser feitas no <a className="font-medium underline" href={meta.hubAppsUrl} target="_blank" rel="noopener noreferrer">Hub Apps</a>.</>}
        </div>
      )}

      {nova && <NovaSugestao onClose={() => setNova(false)} onSaved={(s) => { setLista((l) => [s, ...(l ?? [])]); setNova(false) }} />}

      {lista === null && !error ? <TableSkeleton /> : meta && meta.missing.length === 0 && (
        <>
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {(['todas', 'open', 'planned', 'in_progress', 'done', 'rejected'] as const).map((k) => (
              <button key={k} onClick={() => setFiltro(k)}
                className={clsx('h-7 rounded-md border px-2.5 text-[12px] transition-colors',
                  filtro === k ? 'border-accent bg-accent/10 font-medium text-zinc-900 dark:text-zinc-100'
                    : 'border-zinc-200 text-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-100')}>
                {k === 'todas' ? 'Todas' : STATUS[k].rotulo} <span className="text-zinc-400">{contagem[k] ?? 0}</span>
              </button>
            ))}
          </div>

          {visiveis.length === 0 ? (
            <EmptyState icon={Lightbulb} message={lista?.length ? 'Nenhuma sugestão com esse status.' : 'Ainda não há sugestões para o Data Hub.'} />
          ) : (
            <div className="flex flex-col gap-2">
              {visiveis.map((s) => (
                <article key={s.id} className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex w-12 shrink-0 flex-col items-center gap-1">
                    <button disabled={!escreve} onClick={() => void votar(s, 'like')} title={escreve ? 'Apoiar' : 'Votos são registrados no Hub Apps'}
                      className={clsx('flex w-full items-center justify-center gap-1 rounded-md border py-1 text-[12px] transition-colors disabled:cursor-default',
                        s.viewerVote === 'like' ? 'border-ok bg-ok-soft text-ok dark:bg-ok/15' : 'border-zinc-200 text-zinc-500 enabled:hover:border-ok enabled:hover:text-ok dark:border-zinc-700')}>
                      <ThumbsUp size={12} /> {s.likesCount}
                    </button>
                    <button disabled={!escreve} onClick={() => void votar(s, 'dislike')} title={escreve ? 'Não apoiar' : 'Votos são registrados no Hub Apps'}
                      className={clsx('flex w-full items-center justify-center gap-1 rounded-md border py-1 text-[12px] transition-colors disabled:cursor-default',
                        s.viewerVote === 'dislike' ? 'border-crit bg-crit-soft text-crit dark:bg-crit/15' : 'border-zinc-200 text-zinc-500 enabled:hover:border-crit enabled:hover:text-crit dark:border-zinc-700')}>
                      <ThumbsDown size={12} /> {s.dislikesCount}
                    </button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[13px] font-semibold">{s.title}</h3>
                      {escreve && isAdmin ? (
                        <select value={s.status} onChange={(e) => void status(s, e.target.value as Status)}
                          className={clsx('h-6 rounded-md border-0 px-1.5 text-[11px] font-medium', STATUS[s.status].cor)}>
                          {(meta?.statuses ?? []).map((st) => <option key={st} value={st}>{STATUS[st].rotulo}</option>)}
                        </select>
                      ) : (
                        <span className={clsx('rounded-md px-1.5 py-0.5 text-[11px] font-medium', STATUS[s.status].cor)}>{STATUS[s.status].rotulo}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {s.sector}{s.category ? ` · ${s.category}` : ''} · {s.author.name || s.author.email} · {quando(s.createdAt)}
                    </p>
                    <p className={clsx('mt-1.5 whitespace-pre-line text-[12.5px] text-zinc-700 dark:text-zinc-300', aberta !== s.id && 'line-clamp-3')}>{s.description}</p>

                    <div className="mt-2 flex items-center gap-3">
                      <button onClick={() => setAberta(aberta === s.id ? null : s.id)}
                        className="flex items-center gap-1 text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
                        <MessageSquare size={12} /> {s.commentsCount} comentário{s.commentsCount === 1 ? '' : 's'}
                      </button>
                      {s.supporters.length > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                          <span className="flex -space-x-1.5">{s.supporters.slice(0, 5).map((p) => <Avatar key={p.email} p={p} size={18} />)}</span>
                          {s.supporters.length > 5 && `+${s.supporters.length - 5}`}
                        </span>
                      )}
                    </div>

                    {aberta === s.id && <Comentarios s={s} escreve={escreve} onSaved={troca} />}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  )
}

function Comentarios({ s, escreve, onSaved }: { s: Sugestao; escreve: boolean; onSaved: (s: Sugestao) => void }) {
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  async function enviar() {
    setEnviando(true); setErro(null)
    try {
      onSaved((await api<{ suggestion: Sugestao }>(`/api/v1/suggestions/${s.id}/comments`, { method: 'POST', body: JSON.stringify({ message: texto }) })).suggestion)
      setTexto('')
    } catch (e) { setErro(e instanceof Error ? e.message : 'Falha ao comentar.') }
    finally { setEnviando(false) }
  }
  return (
    <div className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
      {s.comments.length === 0 && <p className="text-[11.5px] text-zinc-400">Sem comentários.</p>}
      <ul className="flex flex-col gap-2">
        {s.comments.map((c) => (
          <li key={c.id} className="flex gap-2">
            <Avatar p={c.author} />
            <div className="min-w-0">
              <p className="text-[11px] text-zinc-500"><b className="font-medium text-zinc-700 dark:text-zinc-300">{c.author.name || c.author.email}</b> · {quando(c.createdAt)}</p>
              <p className="whitespace-pre-line text-[12px]">{c.message}</p>
            </div>
          </li>
        ))}
      </ul>
      {escreve && (
        <div className="mt-2 flex items-center gap-1.5">
          <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva um comentário"
            onKeyDown={(e) => { if (e.key === 'Enter' && texto.trim().length >= 2 && !enviando) void enviar() }}
            className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-[12px] outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950" />
          <button disabled={enviando || texto.trim().length < 2} onClick={() => void enviar()}
            className="flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-[12px] text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {enviando ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Enviar
          </button>
        </div>
      )}
      {erro && <p className="mt-1 text-[11.5px] text-crit dark:text-crit-dark">{erro}</p>}
    </div>
  )
}

function NovaSugestao({ onClose, onSaved }: { onClose: () => void; onSaved: (s: Sugestao) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [sector, setSector] = useState('')
  const [category, setCategory] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const inp = 'w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const valida = title.trim().length >= 5 && description.trim().length >= 15 && sector.trim().length >= 2
  async function salvar() {
    setSalvando(true); setErro(null)
    try {
      onSaved((await api<{ suggestion: Sugestao }>('/api/v1/suggestions', { method: 'POST', body: JSON.stringify({ title, description, sector, category }) })).suggestion)
    } catch (e) { setErro(e instanceof Error ? e.message : 'Falha ao enviar.'); setSalvando(false) }
  }
  return (
    <div className="mb-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Nova sugestão</h2>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={16} /></button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-zinc-500 sm:col-span-2">Título (mínimo 5 caracteres)
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inp} maxLength={191} />
        </label>
        <label className="text-[11px] text-zinc-500 sm:col-span-2">O que melhorar e por quê (mínimo 15 caracteres)
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inp} />
        </label>
        <label className="text-[11px] text-zinc-500">Setor ou área impactada
          <input value={sector} onChange={(e) => setSector(e.target.value)} className={inp} maxLength={120} />
        </label>
        <label className="text-[11px] text-zinc-500">Categoria (opcional)
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={inp} maxLength={120} placeholder="ex.: Conjuntos, Painéis, Notebooks" />
        </label>
      </div>
      {erro && <p className="mt-2 text-[12px] text-crit dark:text-crit-dark">{erro}</p>}
      <div className="mt-2.5 flex gap-2">
        <button disabled={!valida || salvando} onClick={() => void salvar()}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {salvando && <Loader2 size={13} className="animate-spin" />} Enviar sugestão
        </button>
        <button onClick={onClose} className="h-8 rounded-md border border-zinc-200 px-3 text-[12.5px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Cancelar</button>
      </div>
    </div>
  )
}
