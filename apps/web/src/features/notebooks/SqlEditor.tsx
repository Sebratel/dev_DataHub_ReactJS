// Editor SQL. O CodeMirror entra por import dinâmico para não pesar no pacote
// principal — quem nunca abre um notebook não paga por ele.
import { Suspense, lazy } from 'react'
import { useThemeStore } from '@/store/themeStore'

const CodeMirror = lazy(() => import('@uiw/react-codemirror'))
const sqlLang = import('@codemirror/lang-sql')

// A extensão de linguagem também é assíncrona; resolvida uma vez e reusada.
let cachedExtensions: unknown[] | null = null
void sqlLang.then((m) => { cachedExtensions = [m.sql()] })

function Fallback({ value }: { value: string }) {
  return (
    <pre className="m-0 min-h-[84px] overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11.5px] leading-relaxed text-zinc-500">
      {value || ' '}
    </pre>
  )
}

export default function SqlEditor({ value, onChange, onRun, readOnly }: {
  value: string
  onChange: (v: string) => void
  /** Ctrl/⌘+Enter executa — atalho que todo mundo já espera de um notebook. */
  onRun?: () => void
  readOnly?: boolean
}) {
  const theme = useThemeStore((s) => s.theme)
  return (
    <div
      className="min-h-[84px] text-[11.5px]"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          onRun?.()
        }
      }}
    >
      <Suspense fallback={<Fallback value={value} />}>
        <CodeMirror
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          theme={theme === 'dark' ? 'dark' : 'light'}
          extensions={(cachedExtensions ?? []) as never[]}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            autocompletion: true,
          }}
          style={{ fontSize: '11.5px' }}
        />
      </Suspense>
    </div>
  )
}
