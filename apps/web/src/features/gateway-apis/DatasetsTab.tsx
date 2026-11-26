// Conjuntos — só admin. Quais conjuntos saem do Data Hub pelo gateway, numa
// lista só: quem PODE ler (APIs de leitura e tokens com o conjunto no escopo)
// e quem LEU nos últimos 30 dias. Antes isso só se via abrindo API por API e
// token por token.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Database, Star, KeyRound, Webhook, Activity } from 'lucide-react'
import type { GatewayDatasetsOverview, GatewayDatasetUsage } from '@datahub/shared'
import { api } from '@/lib/api'
import { Card, CardHead } from '@/components/ui/Card'
import { EmptyState, FilterChips, SearchInput, Toolbar } from '@/components/ui/Page'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'
import KpiBar from '@/components/ui/KpiBar'
import { errMsg, fmtDate } from './shared'

type Filtro = 'todos' | 'uso' | 'parado'

const fmt = (n: number) => n.toLocaleString('pt-BR')
const fmtDia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`

function nomes(xs: { name: string }[], max = 2): string {
  if (!xs.length) return '—'
  const vis = xs.slice(0, max).map((x) => x.name).join(', ')
  return xs.length > max ? `${vis} +${xs.length - max}` : vis
}

export default function DatasetsTab({ onGoTokens }: { onGoTokens: () => void }) {
  const [data, setData] = useState<GatewayDatasetsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('todos')
  const [q, setQ] = useState('')

  useEffect(() => {
    api<GatewayDatasetsOverview>('/api/v1/gateway/datasets')
      .then(setData).catch((e) => setError(errMsg(e, 'Falha ao carregar os conjuntos.')))
  }, [])

  const all = data?.datasets ?? []
  const emUso = all.filter((d) => d.calls30d > 0)
  const parados = all.filter((d) => d.calls30d === 0)
  const lista = useMemo(() => {
    const t = q.trim().toLowerCase()
    return all.filter((d) => (filtro === 'todos' || (filtro === 'uso' ? d.calls30d > 0 : d.calls30d === 0))
      && (!t || d.name.toLowerCase().includes(t) || d.slug.includes(t)))
  }, [all, filtro, q])

  if (error) return <Card className="p-4 text-[12px] text-crit dark:text-crit-dark">{error}</Card>
  if (!data) return <div className="h-[220px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />

  const chamadas = emUso.reduce((s, d) => s + d.calls30d, 0)
  return (
    <div className="flex flex-col gap-2.5">
      <KpiBar items={[
        { label: 'Lidos por fora (30 dias)', value: fmt(emUso.length), icon: Activity, foot: `${fmt(chamadas)} leituras por token` },
        { label: 'Expostos sem leitura', value: fmt(parados.length), icon: Database, foot: 'API ou token alcança, ninguém leu' },
        {
          label: 'Tokens que leem tudo', value: fmt(data.allAccessTokens.length), icon: KeyRound,
          foot: data.allAccessTokens.length ? nomes(data.allAccessTokens, 2) : 'nenhum: todo token tem escopo',
        },
      ]} />

      <div>
        <Toolbar>
          <FilterChips<Filtro> value={filtro} onChange={setFiltro} options={[
            { key: 'todos', label: 'Todos', count: all.length },
            { key: 'uso', label: 'Em uso', count: emUso.length },
            { key: 'parado', label: 'Sem leitura', count: parados.length },
          ]} />
          <SearchInput value={q} onChange={setQ} placeholder="Buscar conjunto" />
        </Toolbar>
        <Card>
          <CardHead icon={Database} title="Conjuntos servidos pelo gateway" sub={`${lista.length} de ${all.length}`} />
          {lista.length === 0 ? (
            <EmptyState icon={Database} message={all.length
              ? 'Nenhum conjunto com esses filtros.'
              : 'Nenhum conjunto é servido por API ou token com escopo. Tokens que leem tudo aparecem no indicador acima.'} />
          ) : (
            <DataGrid fixed className="min-w-[900px]">
              <thead>
                <tr>
                  <Th>Conjunto</Th>
                  <Th right className="w-[110px]">Leituras 30 d</Th>
                  <Th className="w-[22%]">Quem leu</Th>
                  <Th className="w-[15%]">APIs</Th>
                  <Th className="w-[15%]">Tokens com acesso</Th>
                  <Th className="w-[104px]">Última leitura</Th>
                </tr>
              </thead>
              <tbody>
                {lista.map((d) => <Linha key={d.id} d={d} />)}
              </tbody>
            </DataGrid>
          )}
        </Card>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Leitura = chamada por token que trouxe dados, de qualquer API do conjunto.
        {data.trackingSince ? ` Registrado desde ${fmtDia(data.trackingSince)}: antes disso, "sem leitura" não quer dizer que ninguém usava.` : ' Ainda não há leitura por token registrada.'}
        {data.allAccessTokens.length > 0 && (
          <> Os tokens que leem tudo alcançam também os conjuntos fora desta lista — <button onClick={onGoTokens}
            className="font-medium text-info hover:underline dark:text-info-dark">restrinja o escopo em Tokens</button>.</>
        )}
      </p>
    </div>
  )
}

function Linha({ d }: { d: GatewayDatasetUsage }) {
  return (
    <Tr>
      <Td>
        <Link to={`/datasets/${d.slug}`} className="block min-w-0">
          <EntityCell name={d.name} slug={d.slug}>
            {d.official
              ? <Star size={13} strokeWidth={1.5} className="shrink-0 text-accent" aria-label="Oficial" />
              : <Database size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
          </EntityCell>
        </Link>
      </Td>
      <Td right mono>{d.calls30d ? fmt(d.calls30d) : <Pill>sem leitura</Pill>}</Td>
      <Td muted>
        <span className="block truncate" title={d.consumers30d.map((c) => `${c.name}: ${fmt(c.calls)}`).join('\n')}>
          {nomes(d.consumers30d)}
        </span>
      </Td>
      <Td muted>
        <span className="flex min-w-0 items-center gap-1" title={d.apis.map((a) => `/p/${a.slug}`).join('\n')}>
          {d.apis.length > 0 && <Webhook size={12} className="shrink-0 text-zinc-400" />}
          <span className="truncate">{nomes(d.apis)}</span>
        </span>
      </Td>
      <Td muted>
        <span className="flex min-w-0 items-center gap-1" title={d.tokens.map((t) => t.name).join('\n')}>
          {d.tokens.length > 0 && <KeyRound size={12} className="shrink-0 text-zinc-400" />}
          <span className="truncate">{nomes(d.tokens)}</span>
        </span>
      </Td>
      <Td muted>{d.lastReadAt ? fmtDate(d.lastReadAt) : 'nunca'}</Td>
    </Tr>
  )
}
