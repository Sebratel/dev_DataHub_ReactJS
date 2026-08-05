// Ponte com o runtime Python. O worker é criado na primeira execução e
// reaproveitado — recarregar 10 MB de WebAssembly a cada célula seria absurdo,
// e o estado do interpretador persiste entre células, como num notebook de
// verdade.
//
// `cancel()` mata o worker: é a resposta para laço infinito. O próximo `run()`
// sobe um novo, pagando o carregamento de novo — o preço de ter escapado.
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PythonResult {
  stdout: string
  repr: string | null
  error: string | null
}

export interface PythonInput {
  columns: string[]
  rows: Record<string, unknown>[]
}

export function usePython() {
  const workerRef = useRef<Worker | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const pending = useRef<((r: PythonResult) => void) | null>(null)

  const dispose = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  // Um worker por notebook aberto; morre junto com a página.
  useEffect(() => dispose, [dispose])

  const cancel = useCallback(() => {
    dispose()
    setRunning(false)
    setStatus(null)
    pending.current?.({
      stdout: '',
      repr: null,
      error: 'Execução interrompida. O interpretador foi reiniciado — variáveis anteriores se perderam.',
    })
    pending.current = null
  }, [dispose])

  const run = useCallback((code: string, data: PythonInput | null): Promise<PythonResult> => {
    setRunning(true)
    setStatus('Iniciando…')

    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./pyodideWorker.ts', import.meta.url), { type: 'module' })
    }
    const worker = workerRef.current

    return new Promise<PythonResult>((resolve) => {
      pending.current = resolve
      const finish = (r: PythonResult) => {
        worker.removeEventListener('message', onMessage)
        setRunning(false)
        setStatus(null)
        pending.current = null
        resolve(r)
      }
      function onMessage(e: MessageEvent) {
        const m = e.data as { type: string; message?: string; stdout?: string; repr?: string | null; error?: string }
        if (m.type === 'status') { setStatus(m.message ?? null); return }
        if (m.type === 'done') { finish({ stdout: m.stdout ?? '', repr: m.repr ?? null, error: null }); return }
        if (m.type === 'error') { finish({ stdout: m.stdout ?? '', repr: null, error: m.error ?? 'Erro desconhecido.' }) }
      }
      worker.addEventListener('message', onMessage)
      worker.postMessage({ type: 'run', code, data })
    })
  }, [])

  return { run, cancel, running, status }
}
