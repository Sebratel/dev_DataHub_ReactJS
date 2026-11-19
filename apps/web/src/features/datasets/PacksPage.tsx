// Pacotes de conjuntos calculados (catálogo como código, 19/11/2026). Cada
// pacote traz conjuntos prata/ouro prontos e as cópias bronze de que precisam.
// Instalar é do master (publica fonte) e pode ser repetido: o que já existe
// fica como está. Fora do menu, como a Lixeira: o caminho é "Pacotes" em Conjuntos.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Package, Loader2, Check, Database, GitMerge, CircleDashed, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, ErrorBanner, TableSkeleton, PrimaryButton } from '@/components/ui/Page'
import { Card } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

interface PackStatus {
  id: string
  name: string
  description: string
  sources: { ref: string; name: string; slug: string | null; faltam: string[] }[]
  datasets: {
    slug: string; name: string; domain: string; description: string
    instalado: boolean; rowCount: number | null; lastSyncAt: string | null
  }[]
}

interface InstallReport {
  connectionId: string
  sources: { ref: string; slug: string | null; status: string; detail?: string }[]
  datasets: { slug: string; status: string; detail?: string }[]
}

const DOMINIO: Record<string, string> = { financeiro: 'Financeiro', cancelamento: 'Cancelamento', base: 'Base e receita' }

export default function PacksPage() {
  const confirm = useConfirm()
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [packs, setPacks] = useState<PackStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [report, setReport] = useState<InstallReport | null>(null)

  const load = useCallback(() => {
    api<{ packs: PackStatus[] }>('/api/v1/packs')
      .then((r) => setPacks(r.packs))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar os pacotes.'))
  }, [])
  useEffect(load, [load])

  async function instalar(p: PackStatus) {
    const novas = p.sources.filter((s) => !s.slug).length
    const ok = await confirm({
      title: `Instalar "${p.name}"?`,
      message: `${p.datasets.filter((d) => !d.instalado).length} conjunto(s) calculado(s) novos, em cascata. ` +
        (novas ? `${novas} tabela(s) do Voalle ainda não copiada(s) entram na fila de carga, só com as colunas usadas. ` : '') +
        'Os conjuntos nascem privados: libere o acesso para as áreas em cada um.',
      confirmLabel: 'Instalar',
    })
    if (!ok) return
    setBusy(p.id)
    setError(null)
    try {
      const r = await api<{ report: InstallReport }>(`/api/v1/packs/${p.id}/install`, { method: 'POST', body: '{}' })
      setReport(r.report)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao instalar.')
    } finally {
      setBusy(null)
    }
  }

  const problemas = report
    ? [...report.sources.filter((s) => s.status === 'erro' || s.status === 'incompleta').map((s) => `${s.ref}: ${s.detail}`),
       ...report.datasets.filter((d) => d.status === 'erro' || d.status === 'pulado').map((d) => `${d.slug}: ${d.detail}`)]
    : []

  return (
    <Page>
      <PageHeader
        icon={Package}
        title="Pacotes de conjuntos"
        subtitle="Conjuntos calculados prontos (prata e ouro), instalados com as cópias da fonte de que precisam."
        back={(
          <Link to="/datasets" className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-accent">
            <ArrowLeft size={13} /> Conjuntos
          </Link>
        )}
      />

      {error && <ErrorBanner message={error} />}
      {report && (
        <div className="mb-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[12px] dark:border-zinc-800 dark:bg-zinc-900">
          <b>Instalado</b> pela conexão {report.connectionId}:{' '}
          {report.datasets.filter((d) => d.status === 'criado').length} calculado(s) criado(s),{' '}
          {report.sources.filter((s) => s.status === 'criada').length} cópia(s) nova(s) na fila de carga.
          {problemas.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-crit dark:text-crit-dark">
              {problemas.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
      )}

      {packs === null && !error ? <TableSkeleton /> : packs?.map((p) => {
        const faltam = p.datasets.filter((d) => !d.instalado).length
        return (
          <Card key={p.id} className="mb-3">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
              <div>
                <div className="text-[13px] font-semibold">{p.name}</div>
                <div className="text-[11.5px] text-zinc-500">{p.description}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
                  {p.sources.map((s) => (
                    <span key={s.ref} title={s.faltam.length ? `Faltam colunas: ${s.faltam.join(', ')}` : s.slug ?? 'ainda não copiada'}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-700">
                      {s.faltam.length ? <AlertTriangle size={11} className="text-warn" />
                        : s.slug ? <Database size={11} className="text-ok dark:text-ok-dark" /> : <CircleDashed size={11} />}
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
              {isMaster ? (
                <PrimaryButton icon={busy === p.id ? undefined : Package} disabled={!faltam || !!busy} onClick={() => void instalar(p)}>
                  {busy === p.id ? <><Loader2 size={14} className="animate-spin" /> Instalando</> : faltam ? `Instalar (${faltam})` : 'Instalado'}
                </PrimaryButton>
              ) : (
                <span className="text-[11px] text-zinc-400">Só um admin master instala.</span>
              )}
            </div>
            <DataGrid fixed>
              <thead>
                <tr>
                  <Th>Conjunto</Th>
                  <Th className="w-[130px]">Área</Th>
                  <Th className="w-[110px]" right>Linhas</Th>
                  <Th className="w-[110px]" right>Situação</Th>
                </tr>
              </thead>
              <tbody>
                {p.datasets.map((d) => (
                  <Tr key={d.slug}>
                    <Td>
                      <span title={d.description}>
                        {d.instalado ? (
                          <Link to={`/datasets/${d.slug}`} className="hover:text-accent">
                            <EntityCell name={d.name} slug={d.slug}><GitMerge size={13} className="shrink-0 text-zinc-400" /></EntityCell>
                          </Link>
                        ) : (
                          <EntityCell name={d.name} slug={d.slug}><GitMerge size={13} className="shrink-0 text-zinc-300" /></EntityCell>
                        )}
                      </span>
                    </Td>
                    <Td muted>{DOMINIO[d.domain] ?? d.domain}</Td>
                    <Td right muted>{d.rowCount == null ? '—' : d.rowCount.toLocaleString('pt-BR')}</Td>
                    <Td right>
                      {d.instalado
                        ? (d.lastSyncAt
                          ? <span className="inline-flex items-center gap-1 text-[11.5px] text-ok dark:text-ok-dark"><Check size={12} /> pronto</span>
                          : <span className="text-[11.5px] text-zinc-500">aguardando carga</span>)
                        : <span className="text-[11.5px] text-zinc-400">não instalado</span>}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </DataGrid>
          </Card>
        )
      })}
    </Page>
  )
}
