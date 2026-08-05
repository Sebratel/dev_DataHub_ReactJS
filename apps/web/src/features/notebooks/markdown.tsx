// Renderizador de Markdown mínimo para as células de texto.
//
// Escrito à mão, sem biblioteca, por um motivo de segurança: um notebook pode
// ser compartilhado com o tenant inteiro, então o texto de uma pessoa é
// renderizado no navegador de outra. Aqui NADA vira HTML — cada pedaço vira
// elemento React, o que torna injeção impossível por construção, em vez de
// depender de sanitização depois.
//
// Cobre o que se usa de fato numa análise: títulos, listas, negrito, itálico,
// código e link. Quem precisar de mais usa uma célula SQL.
import { Fragment, type ReactNode } from 'react'

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] dark:bg-zinc-800">
          {part.slice(1, -1)}
        </code>
      )
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const href = link[2]
      // Só http(s): impede javascript: e data: virarem link clicável.
      const safe = /^https?:\/\//i.test(href)
      return safe
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener"
             className="text-info hover:underline dark:text-info-dark">{link[1]}</a>
        : <span key={key}>{link[1]}</span>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

export default function Markdown({ source }: { source: string }) {
  const lines = source.split('\n')
  const out: ReactNode[] = []
  let list: string[] = []

  const flushList = (key: string) => {
    if (!list.length) return
    out.push(
      <ul key={key} className="my-1.5 list-disc space-y-0.5 pl-5">
        {list.map((item, i) => <li key={i}>{inline(item, `${key}-${i}`)}</li>)}
      </ul>,
    )
    list = []
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) { list.push(bullet[1]); return }
    flushList(`ul-${i}`)

    if (!line.trim()) return
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const cls = level === 1 ? 'text-[15px] font-semibold mt-2'
        : level === 2 ? 'text-[13.5px] font-semibold mt-2'
        : 'text-[12.5px] font-semibold mt-1.5'
      out.push(<p key={i} className={`${cls} tracking-tight`}>{inline(h[2], `h-${i}`)}</p>)
      return
    }
    out.push(<p key={i} className="my-1 leading-relaxed">{inline(line, `p-${i}`)}</p>)
  })
  flushList('ul-end')

  return <div className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{out}</div>
}
