// Padronizar nomes dos conjuntos (19/11/2026): <camada>_<área>_<assunto>, em
// minúsculas e com "_" entre as palavras. Conjunto novo já nasce assim; aqui
// ficam os antigos, com o nome sugerido pronto para aplicar. O nome antigo
// vira apelido no servidor — link, token, SQL e painel seguem funcionando.
//
// Fica fora do menu, como a Lixeira: é tarefa de passagem, e o menu Operar já
// foi enxugado. O caminho é o botão "Padronizar nomes" em Conjuntos.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Tags, Loader2, Check, GitMerge, Database, Lock } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import {
  Page, PageHeader, EmptyState, ErrorBanner, TableSkeleton, Toolbar, FilterChips, SearchInput, PrimaryButton,
} from '@/components/ui/Page'
import { Card } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

interface ItemNome {
  id: string
  slug: string
  name: string
  kind: 'source' | 'derived'
  official: boolean
  conforme: boolean
  sugestao: string | null
  apelidos: string[]
}

const PADRAO = /^(bronze|prata|ouro)(_[a-z0-9]+)+$/
const MAX = 80
const valido = (s: string) => s.length <= MAX && PADRAO.test(s)

type Filtro = 'fora' | 'todos'

export default function NamingPage() {
  const confirm = useConfirm()
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [items, setItems] = useState<ItemNome[] | null>(null)
  const [nomes, setNomes] = useState<Record<string, string>>({})
  const [filtro, setFiltro] = useState<Filtro>('fora')
  const [busca, setBusca] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lote, setLote] = useState<{ feitos: number; total: number } | null>(null)

  const load = useCallback(() => {
    api<{ items: ItemNome[] }>('/api/v1/datasets/naming')
      .then((r) => {
        setItems(r.items)
        setNomes(Object.fromEntries(r.items.filter((i) => i.sugestao).map((i) => [i.id, i.sugestao!])))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar os nomes.'))
  }, [])
  useEffect(load, [load])

  const fora = items?.filter((i) => !i.conforme) ?? []
  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return (filtro === 'fora' ? fora : items ?? [])
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.slug.includes(q))
  }, [items, fora, filtro, busca])

  const podeRenomear = (i: ItemNome) => !i.official || isMaster
  const aplicaveis = fora.filter((i) => podeRenomear(i) && valido(nomes[i.id] ?? ''))

  async function renomear(i: ItemNome): Promise<string | null> {
    try {
      await api(`/api/v1/datasets/${i.id}/rename`, { method: 'POST', body: JSON.stringify({ slug: nomes[i.id] }) })
      return null
    } catch (e) {
      return `${i.name}: ${e instanceof Error ? e.message : 'falha ao renomear'}`
    }
  }

  async function aplicar(i: ItemNome) {
    setBusy(i.id)
    setError(null)
    const erro = await renomear(i)
    if (erro) setError(erro)
    setBusy(null)
    load()
  }

  async function aplicarTodas() {
    const ok = await confirm({
      title: `Renomear ${aplicaveis.length} conjunto(s)?`,
      message: 'Cada um passa a usar o nome da coluna "Novo nome". O nome antigo continua funcionando como apelido ' +
        '(links, tokens, SQL e painéis). No Databricks, a tabela é recriada com o nome novo no próximo envio.',
      confirmLabel: 'Renomear todos',
    })
    if (!ok) return
    setError(null)
    const erros: string[] = []
    setLote({ feitos: 0, total: aplicaveis.length })
    for (const [n, i] of aplicaveis.entries()) {
      const erro = await renomear(i)
      if (erro) erros.push(erro)
      setLote({ feitos: n + 1, total: aplicaveis.length })
    }
    setLote(null)
    if (erros.length) setError(`${erros.length} não renomeado(s). ${erros.slice(0, 3).join(' · ')}${erros.length > 3 ? ' …' : ''}`)
    load()
  }

  return (
    <Page>
      <PageHeader
        icon={Tags}
        title="Padronizar nomes"
        subtitle="Padrão: camada_área_assunto, em minúsculas. Ex.: bronze_voalle_contratos, ouro_financeiro_titulos_abertos."
        back={(
          <Link to="/datasets" className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-accent">
            <ArrowLeft size={13} /> Conjuntos
          </Link>
        )}
      >
        <PrimaryButton icon={lote ? undefined : Check} disabled={!aplicaveis.length || !!lote || !!busy} onClick={() => void aplicarTodas()}>
          {lote ? <><Loader2 size={14} className="animate-spin" /> {lote.feitos}/{lote.total}</> : `Renomear todos (${aplicaveis.length})`}
        </PrimaryButton>
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      <Toolbar>
        <FilterChips<Filtro>
          value={filtro}
          onChange={setFiltro}
          options={[
            { key: 'fora', label: 'Fora do padrão', count: fora.length },
            { key: 'todos', label: 'Todos', count: items?.length ?? 0 },
          ]}
        />
        <span className="text-[11.5px] text-zinc-500">
          Camadas: <b>bronze</b> cópia da fonte · <b>prata</b> tratado · <b>ouro</b> pronto para a área
        </span>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar conjunto" />
      </Toolbar>

      {items === null && !error ? <TableSkeleton /> : (
        <Card>
          {visiveis.length === 0 ? (
            <EmptyState icon={Tags} message={filtro === 'fora' && !busca
              ? 'Todos os conjuntos já seguem o padrão.'
              : 'Nenhum conjunto encontrado.'} />
          ) : (
            <DataGrid fixed>
              <thead>
                <tr>
                  <Th>Conjunto</Th>
                  <Th className="w-[44%]">Novo nome</Th>
                  <Th className="w-[120px]" right>Ação</Th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((i) => {
                  const nome = nomes[i.id] ?? ''
                  const invalido = !i.conforme && !valido(nome)
                  return (
                    <Tr key={i.id}>
                      <Td>
                        <EntityCell name={i.name} slug={i.slug}>
                          {i.kind === 'derived'
                            ? <GitMerge size={13} className="shrink-0 text-zinc-400" />
                            : <Database size={13} className="shrink-0 text-zinc-400" />}
                        </EntityCell>
                      </Td>
                      <Td>
                        {i.conforme ? (
                          <span className="text-[11.5px] text-zinc-500" title={i.apelidos.length ? `Apelidos: ${i.apelidos.join(', ')}` : undefined}>
                            <Check size={12} className="mr-1 inline text-ok dark:text-ok-dark" />
                            no padrão{i.apelidos.length ? ` · antes: ${i.apelidos.join(', ')}` : ''}
                          </span>
                        ) : (
                          <input
                            value={nome}
                            onChange={(e) => setNomes((n) => ({ ...n, [i.id]: e.target.value.trim().toLowerCase() }))}
                            spellCheck={false}
                            title={invalido ? 'Use camada_área_assunto: minúsculas, números e "_" (camada bronze, prata ou ouro).' : undefined}
                            className={clsx(
                              'h-[26px] w-full rounded-md border bg-white px-2 font-mono text-[11.5px] outline-none dark:bg-zinc-900',
                              invalido
                                ? 'border-crit/60 focus:ring-2 focus:ring-crit/15'
                                : 'border-zinc-200 focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-zinc-700',
                            )}
                          />
                        )}
                      </Td>
                      <Td right>
                        {!i.conforme && (podeRenomear(i) ? (
                          <button
                            onClick={() => void aplicar(i)}
                            disabled={invalido || busy === i.id || !!lote}
                            className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium transition-colors hover:border-zinc-300 disabled:opacity-50 dark:border-zinc-700"
                          >
                            {busy === i.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                            Renomear
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400" title="Conjunto oficial: só um admin master renomeia.">
                            <Lock size={11} /> só master
                          </span>
                        ))}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataGrid>
          )}
        </Card>
      )}
    </Page>
  )
}
