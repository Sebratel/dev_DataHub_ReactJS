// "O que o assistente sabe" deste conjunto (27/11/2026).
//
// Mostra o que vai para a IA quando ela abre o conjunto — as regras que vêm
// da tabela de origem e do pacote, o perfil lido do lake e as notas da equipe —
// e deixa quem é dono (ou admin) ensinar o que falta: para que serve, o que
// uma linha é, como se calcula o indicador, o que NÃO somar. Fechado por
// padrão: é consulta ocasional, não parte do dia a dia da tela.
import { useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles, Loader2, Check } from 'lucide-react'
import { api } from '@/lib/api'

interface CampoIA {
  key: string
  label?: string
  type: string
  description?: string
  nota?: string
  sensivel?: string
  nulos_pct?: number
  distintos?: number
  min?: string | null
  max?: string | null
  valores?: { valor: unknown; linhas: number }[]
  exemplos?: unknown[]
}

interface ConhecimentoIA {
  tabela_de_origem?: string
  conhecimento: { pacote?: string; resumo: string | null; grao: string | null; armadilhas: string[] }
  chave_provavel?: string[]
  perfil_indisponivel?: string
  campos: CampoIA[]
  notas: string
  notasAtualizadas: { por: string; em: string } | null
  podeEnsinar: boolean
}

const fmt = (n: number) => n.toLocaleString('pt-BR')

function resumoDoCampo(c: CampoIA): string {
  if (c.sensivel) return 'sensível — nenhum valor vai para a IA'
  const partes: string[] = []
  if (c.nulos_pct != null && c.nulos_pct > 0) partes.push(`${String(c.nulos_pct).replace('.', ',')}% vazio`)
  if (c.valores?.length) {
    partes.push(c.valores.slice(0, 6).map((v) => `${String(v.valor)} (${fmt(v.linhas)})`).join(' · ') + (c.valores.length > 6 ? ' · …' : ''))
  } else if (c.exemplos?.length) {
    partes.push(`ex.: ${c.exemplos.map(String).join(' · ')}`)
  } else if (c.min != null || c.max != null) {
    partes.push(`${c.min ?? '?'} → ${c.max ?? '?'}`)
  }
  if (c.distintos != null && !c.valores?.length) partes.push(`~${fmt(c.distintos)} distintos`)
  return partes.join(' · ')
}

export default function AiKnowledgePanel({ slug }: { slug: string }) {
  const [aberto, setAberto] = useState(false)
  const [info, setInfo] = useState<ConhecimentoIA | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [notas, setNotas] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [salvo, setSalvo] = useState(false)

  async function carregar() {
    setCarregando(true); setErro(null)
    try {
      const r = await api<ConhecimentoIA>(`/api/v1/ai/knowledge/${encodeURIComponent(slug)}`)
      setInfo(r); setNotas(r.notas)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar.')
    } finally {
      setCarregando(false)
    }
  }

  function alternar() {
    const novo = !aberto
    setAberto(novo)
    if (novo && !info && !carregando) void carregar()
  }

  async function salvar() {
    setSalvando(true); setErro(null); setSalvo(false)
    try {
      await api(`/api/v1/ai/knowledge/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify({ notas }) })
      setSalvo(true)
      setInfo((i) => (i ? { ...i, notas } : i))
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar.')
    } finally {
      setSalvando(false)
    }
  }

  const k = info?.conhecimento
  return (
    <section className="mt-5">
      <button onClick={alternar}
        className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
        {aberto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Sparkles size={13} /> O que o assistente sabe
      </button>
      {aberto && (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm shadow-card dark:border-zinc-800 dark:bg-zinc-950">
          {carregando && <p className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 size={13} className="animate-spin" /> Lendo o conjunto…</p>}
          {erro && <p className="rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/40">{erro}</p>}
          {info && k && (
            <div className="space-y-3">
              <div className="grid gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-[110px_1fr]">
                <span className="text-zinc-400">Para que serve</span>
                <span>{k.resumo ?? <em className="text-zinc-400">ninguém escreveu ainda — use as notas abaixo</em>}</span>
                <span className="text-zinc-400">Uma linha é</span>
                <span>{k.grao ?? <em className="text-zinc-400">não informado</em>}</span>
                {info.tabela_de_origem && (<><span className="text-zinc-400">Origem</span><span className="font-mono text-[11px]">{info.tabela_de_origem}</span></>)}
                {k.pacote && (<><span className="text-zinc-400">Pacote</span><span>{k.pacote}</span></>)}
                {info.chave_provavel?.length ? (<><span className="text-zinc-400">Identifica a linha</span><span className="font-mono text-[11px]">{info.chave_provavel.join(', ')}</span></>) : null}
              </div>

              {k.armadilhas.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Armadilhas que ele conhece</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
                    {k.armadilhas.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </div>
              )}

              <div>
                <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Notas da equipe</p>
                {info.podeEnsinar ? (
                  <>
                    <textarea value={notas} onChange={(e) => { setNotas(e.target.value); setSalvo(false) }} rows={4}
                      placeholder="Ex.: uma linha por protocolo; para reparo use grupo = 'Manutenção'; o valor está em centavos; não some com a tabela X…"
                      className="w-full resize-y rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-900" />
                    <div className="mt-1.5 flex items-center gap-2">
                      <button onClick={() => void salvar()} disabled={salvando || notas === info.notas}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
                        {salvando ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Salvar
                      </button>
                      {salvo && <span className="text-xs text-emerald-600">Salvo — vale a partir da próxima pergunta.</span>}
                      {!salvo && info.notasAtualizadas && (
                        <span className="text-[11px] text-zinc-400">
                          por {info.notasAtualizadas.por} em {new Date(info.notasAtualizadas.em).toLocaleDateString('pt-BR')}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                    {info.notas || <em className="text-zinc-400">Nenhuma. O dono do conjunto ou um administrador pode escrever.</em>}
                  </p>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Perfil lido do lake <span className="font-normal text-zinc-400">(atualiza a cada carga; vale sozinho para conjunto novo)</span>
                </p>
                {info.perfil_indisponivel && <p className="text-xs text-amber-600">{info.perfil_indisponivel}</p>}
                <div className="max-h-72 overflow-auto rounded-md border border-zinc-100 dark:border-zinc-800">
                  <table className="w-full text-left text-[11.5px]">
                    <tbody>
                      {info.campos.map((c) => (
                        <tr key={c.key} className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800">
                          <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{c.key}</td>
                          <td className="px-2 py-1 text-zinc-500">
                            {c.nota && <span className="block text-zinc-700 dark:text-zinc-300">{c.nota}</span>}
                            <span className="break-words">{resumoDoCampo(c)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
