// Padronizar nomes dos conjuntos (19/11/2026, revisto em 24/11):
//   FONTE       o nome da TABELA no banco, técnico e de exibição, sem mudança —
//               uma query copiada do banco roda aqui sem ajuste. Não se edita.
//   CALCULADO   técnico <camada>_<área>_<assunto> (oficial = ouro); exibição em
//               frase com acentos e siglas: "Protocolos de instalação - SLAs".
// Conjunto novo já nasce assim; aqui ficam os antigos, com a sugestão pronta.
// O nome técnico antigo vira apelido no servidor — link, token, SQL e painel
// seguem funcionando.
//
// Fica fora do menu, como a Lixeira: é tarefa de passagem. O caminho é o botão
// "Padronizar nomes" em Conjuntos.
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
  /** fonte = nome da tabela; api = fonte HTTP (padrão com camada); calculado. */
  regra: 'fonte' | 'api' | 'calculado'
  /** Nome técnico no padrão (fonte: o da tabela; calculado: camada certa). */
  conforme: boolean
  sugestao: string | null
  apelidos: string[]
  /** Nome de exibição no padrão. */
  nomeConforme: boolean
  sugestaoNome: string | null
}

const PADRAO = /^(bronze|prata|ouro)(_[a-z0-9]+)+$/
const MAX = 80
// Fonte: só o nome da tabela que o servidor sugeriu vale (não se edita).
const valido = (i: ItemNome, s: string) =>
  i.regra === 'fonte' ? !!s && s === i.sugestao : s.length <= MAX && PADRAO.test(s)
const NOME_MAX = 200
const nomeValido = (s: string) => s.trim().length > 0 && s.trim().length <= NOME_MAX

type Filtro = 'fora' | 'todos'

const input = (invalido: boolean, mono: boolean) => clsx(
  'h-[26px] w-full rounded-md border bg-white px-2 text-[11.5px] outline-none disabled:opacity-60 dark:bg-zinc-900',
  mono && 'font-mono',
  invalido
    ? 'border-crit/60 focus:ring-2 focus:ring-crit/15'
    : 'border-zinc-200 focus:border-accent focus:ring-2 focus:ring-accent/15 dark:border-zinc-700',
)

// Fonte não se edita: o nome é o da tabela no banco.
function TabelaFixa({ nome, travada }: { nome: string; travada?: boolean }) {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-zinc-700 dark:text-zinc-300"
      title={travada
        ? 'Conjunto oficial: só um admin master troca o nome técnico.'
        : 'Nome da tabela no banco — fonte não muda de nome, para a query do banco rodar aqui.'}
    >
      <Database size={11} className="shrink-0 text-zinc-400" />
      <span className="truncate">{nome}</span>
      {travada && <Lock size={11} className="shrink-0 text-zinc-400" aria-label="só master" />}
    </span>
  )
}

function NoPadrao({ title }: { title?: string }) {
  return (
    <span className="text-[11.5px] text-zinc-500" title={title}>
      <Check size={12} className="mr-1 inline text-ok dark:text-ok-dark" />
      no padrão
    </span>
  )
}

export default function NamingPage() {
  const confirm = useConfirm()
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [items, setItems] = useState<ItemNome[] | null>(null)
  const [slugs, setSlugs] = useState<Record<string, string>>({})
  const [exibicoes, setExibicoes] = useState<Record<string, string>>({})
  const [filtro, setFiltro] = useState<Filtro>('fora')
  const [busca, setBusca] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [lote, setLote] = useState<{ feitos: number; total: number } | null>(null)

  const load = useCallback(() => {
    api<{ items: ItemNome[] }>('/api/v1/datasets/naming')
      .then((r) => {
        setItems(r.items)
        setSlugs(Object.fromEntries(r.items.filter((i) => i.sugestao).map((i) => [i.id, i.sugestao!])))
        setExibicoes(Object.fromEntries(r.items.filter((i) => i.sugestaoNome).map((i) => [i.id, i.sugestaoNome!])))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar os nomes.'))
  }, [])
  useEffect(load, [load])

  const fora = useMemo(() => items?.filter((i) => !i.conforme || !i.nomeConforme) ?? [], [items])
  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return (filtro === 'fora' ? fora : items ?? [])
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.slug.includes(q))
  }, [items, fora, filtro, busca])

  // O nome técnico de um oficial é contrato com quem o usa: só o master troca.
  // O de exibição qualquer admin troca.
  const podeSlug = (i: ItemNome) => !i.official || isMaster
  const trocaSlug = (i: ItemNome) => !i.conforme && podeSlug(i) && valido(i, slugs[i.id] ?? '') && slugs[i.id] !== i.slug
  const trocaNome = (i: ItemNome) => !i.nomeConforme && nomeValido(exibicoes[i.id] ?? '') && exibicoes[i.id].trim() !== i.name
  const aplicaveis = fora.filter((i) => trocaSlug(i) || trocaNome(i))

  async function renomear(i: ItemNome): Promise<string | null> {
    try {
      if (trocaSlug(i)) {
        await api(`/api/v1/datasets/${i.id}/rename`, { method: 'POST', body: JSON.stringify({ slug: slugs[i.id] }) })
      }
      if (trocaNome(i)) {
        await api(`/api/v1/datasets/${i.id}`, { method: 'PATCH', body: JSON.stringify({ name: exibicoes[i.id].trim() }) })
      }
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
      title: `Padronizar ${aplicaveis.length} conjunto(s)?`,
      message: 'Cada um passa a usar o nome técnico e o nome de exibição das colunas ao lado. O nome técnico antigo ' +
        'continua funcionando como apelido (links, tokens, SQL e painéis). No Databricks, a tabela é recriada com o ' +
        'nome novo no próximo envio.',
      confirmLabel: 'Padronizar todos',
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
    if (erros.length) setError(`${erros.length} não padronizado(s). ${erros.slice(0, 3).join(' · ')}${erros.length > 3 ? ' …' : ''}`)
    load()
  }

  return (
    <Page>
      <PageHeader
        icon={Tags}
        title="Padronizar nomes"
        subtitle="Fontes: o nome da tabela no banco, sem mudança, para uma query copiada do banco rodar aqui. Calculados: camada_área_assunto (ex.: ouro_financeiro_titulos_abertos) e nome de exibição em frase com acentos."
        back={(
          <Link to="/datasets" className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-accent">
            <ArrowLeft size={13} /> Conjuntos
          </Link>
        )}
      >
        <PrimaryButton icon={lote ? undefined : Check} disabled={!aplicaveis.length || !!lote || !!busy} onClick={() => void aplicarTodas()}>
          {lote ? <><Loader2 size={14} className="animate-spin" /> {lote.feitos}/{lote.total}</> : `Padronizar todos (${aplicaveis.length})`}
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
          Calculados: <b>prata</b> tratado · <b>ouro</b> oficial ou pronto para a área
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
                  <Th className="w-[31%]">Nome técnico</Th>
                  <Th className="w-[29%]">Nome de exibição</Th>
                  <Th className="w-[112px]" right>Ação</Th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((i) => {
                  const slug = slugs[i.id] ?? ''
                  const exib = exibicoes[i.id] ?? ''
                  const slugInvalido = !i.conforme && podeSlug(i) && !valido(i, slug)
                  const fonte = i.regra === 'fonte'
                  const nomeInvalido = !i.nomeConforme && !nomeValido(exib)
                  const temAcao = !i.conforme || !i.nomeConforme
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
                          <NoPadrao title={i.apelidos.length ? `Antes: ${i.apelidos.join(', ')}` : undefined} />
                        ) : fonte ? (
                          <TabelaFixa nome={slug} travada={!podeSlug(i)} />
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <input
                              id={`slug-${i.id}`}
                              aria-label={`Nome técnico de ${i.name}`}
                              value={slug}
                              onChange={(e) => setSlugs((n) => ({ ...n, [i.id]: e.target.value.trim().toLowerCase() }))}
                              disabled={!podeSlug(i)}
                              spellCheck={false}
                              title={!podeSlug(i)
                                ? 'Conjunto oficial: só um admin master troca o nome técnico.'
                                : slugInvalido ? 'Use camada_área_assunto: minúsculas, números e "_" (camada bronze, prata ou ouro).' : undefined}
                              className={input(slugInvalido, true)}
                            />
                            {!podeSlug(i) && <Lock size={11} className="shrink-0 text-zinc-400" aria-label="só master" />}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {i.nomeConforme ? <NoPadrao /> : fonte ? <TabelaFixa nome={exib} /> : (
                          <input
                            id={`nome-${i.id}`}
                            aria-label={`Nome de exibição de ${i.name}`}
                            value={exib}
                            onChange={(e) => setExibicoes((n) => ({ ...n, [i.id]: e.target.value }))}
                            title={nomeInvalido ? 'O nome de exibição não pode ficar vazio.' : undefined}
                            className={input(nomeInvalido, false)}
                          />
                        )}
                      </Td>
                      <Td right>
                        {temAcao && (
                          <button
                            onClick={() => void aplicar(i)}
                            disabled={!(trocaSlug(i) || trocaNome(i)) || busy === i.id || !!lote}
                            className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium transition-colors hover:border-zinc-300 disabled:opacity-50 dark:border-zinc-700"
                          >
                            {busy === i.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                            Aplicar
                          </button>
                        )}
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
