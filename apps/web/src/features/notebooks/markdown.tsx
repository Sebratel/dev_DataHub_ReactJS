// Renderizador de Markdown mínimo para as células de texto e as respostas do
// assistente.
//
// Escrito à mão, sem biblioteca, por um motivo de segurança: um notebook pode
// ser compartilhado com o tenant inteiro, então o texto de uma pessoa é
// renderizado no navegador de outra — e a resposta da IA é texto que veio de
// fora da empresa. Aqui NADA vira HTML — cada pedaço vira elemento React, o
// que torna injeção impossível por construção, em vez de depender de
// sanitização depois.
//
// Cobre o que se usa de fato numa análise: títulos, listas (com e sem número),
// tabelas, negrito, itálico, código e link. Link só para http(s) ou para uma
// tela do próprio Data Hub (/notebooks/…), nunca javascript: ou data:.
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold text-zinc-900 dark:text-zinc-100">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] dark:bg-zinc-800">
          {part.slice(1, -1)}
        </code>
      )
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      const href = link[2]
      // Tela do próprio Data Hub: navega sem recarregar. "//" seria outro site.
      if (/^\/(?!\/)[\w\-/#?=&.%]*$/.test(href)) {
        return <Link key={key} to={href} className="font-medium text-info hover:underline dark:text-info-dark">{link[1]}</Link>
      }
      // Só http(s): impede javascript: e data: virarem link clicável.
      return /^https?:\/\//i.test(href)
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener"
             className="text-info hover:underline dark:text-info-dark">{link[1]}</a>
        : <span key={key}>{link[1]}</span>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

// "| a | b |" → ['a', 'b']
function celulas(linha: string): string[] {
  return linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}
const SEPARADOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
// Célula que é número (1.234,5 · 12,3% · R$ 1.234 · -4) alinha à direita.
const NUMERICA = /^[-+]?(R\$\s?)?[\d.,]+\s?(%|mil|mi|bi)?$/

function Tabela({ linhas, k }: { linhas: string[]; k: string }) {
  const temCabecalho = linhas.length > 1 && SEPARADOR.test(linhas[1])
  const cab = temCabecalho ? celulas(linhas[0]) : null
  const corpo = (temCabecalho ? linhas.slice(2) : linhas).map(celulas)
  // Coluna de números alinha à direita — o título junto com as células. Vale
  // o que o separador pedir (---: direita, :--- esquerda); sem pedido, a
  // coluna é numérica quando a maioria das células é.
  const sep = temCabecalho ? celulas(linhas[1]) : []
  const nCols = Math.max(cab?.length ?? 0, ...corpo.map((r) => r.length))
  const direita = Array.from({ length: nCols }, (_, i) => {
    const s = sep[i] ?? ''
    if (/-:$/.test(s) && !/^:/.test(s)) return true
    if (/^:-/.test(s)) return false
    const vals = corpo.map((r) => (r[i] ?? '').replace(/\*\*/g, '')).filter(Boolean)
    return vals.length > 0 && vals.filter((v) => NUMERICA.test(v)).length / vals.length >= 0.6
  })
  return (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]">
        {cab && (
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-700">
              {cab.map((c, i) => (
                <th key={i} className={`whitespace-nowrap px-2 py-1 font-semibold text-zinc-700 dark:text-zinc-200 ${direita[i] ? 'text-right' : 'text-left'}`}>
                  {inline(c, `${k}-h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {corpo.map((r, j) => (
            <tr key={j} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
              {r.map((c, i) => (
                <td key={i} className={`px-2 py-1 ${direita[i] ? 'whitespace-nowrap text-right tabular-nums' : ''}`}>
                  {inline(c, `${k}-${j}-${i}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.split('\n')
  const out: ReactNode[] = []
  let list: string[] = []
  let ordered = false
  let tabela: string[] = []
  let codigo: string[] | null = null

  const flushList = (key: string) => {
    if (!list.length) return
    const itens = list.map((item, i) => <li key={i}>{inline(item, `${key}-${i}`)}</li>)
    out.push(ordered
      ? <ol key={key} className="my-1.5 list-decimal space-y-0.5 pl-5">{itens}</ol>
      : <ul key={key} className="my-1.5 list-disc space-y-0.5 pl-5">{itens}</ul>)
    list = []
  }
  const flushTabela = (key: string) => {
    if (!tabela.length) return
    out.push(<Tabela key={key} k={key} linhas={tabela} />)
    tabela = []
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()

    // Bloco de código: tudo literal até a cerca de fechamento.
    if (/^\s*```/.test(line)) {
      if (codigo) {
        out.push(
          <pre key={`code-${i}`} className="my-2 overflow-x-auto rounded-md bg-zinc-100 p-2 font-mono text-[11px] leading-snug dark:bg-zinc-800">
            {codigo.join('\n')}
          </pre>,
        )
        codigo = null
      } else {
        flushList(`ul-${i}`); flushTabela(`tb-${i}`)
        codigo = []
      }
      return
    }
    if (codigo) { codigo.push(raw); return }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList(`ul-${i}`)
      tabela.push(line)
      return
    }
    flushTabela(`tb-${i}`)

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numero = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numero) {
      const novoOrdered = !!numero
      if (list.length && novoOrdered !== ordered) flushList(`ul-${i}`)
      ordered = novoOrdered
      list.push((bullet ?? numero)![1])
      return
    }
    flushList(`ul-${i}`)

    if (!line.trim()) return
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push(<hr key={i} className="my-2 border-zinc-200 dark:border-zinc-800" />)
      return
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const cls = level === 1 ? 'text-[15px] font-semibold mt-2'
        : level === 2 ? 'text-[13.5px] font-semibold mt-2'
        : 'text-[12.5px] font-semibold mt-1.5'
      out.push(<p key={i} className={`${cls} tracking-tight text-zinc-900 dark:text-zinc-100`}>{inline(h[2], `h-${i}`)}</p>)
      return
    }
    out.push(<p key={i} className="my-1 leading-relaxed">{inline(line, `p-${i}`)}</p>)
  })
  flushList('ul-end')
  flushTabela('tb-end')
  if (codigo) {
    out.push(<pre key="code-end" className="my-2 overflow-x-auto rounded-md bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-800">{(codigo as string[]).join('\n')}</pre>)
  }

  return <div className={className ?? 'text-[12.5px] text-zinc-700 dark:text-zinc-300'}>{out}</div>
}
