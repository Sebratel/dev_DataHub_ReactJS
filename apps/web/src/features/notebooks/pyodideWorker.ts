// Worker do runtime Python (Pyodide — CPython compilado para WebAssembly).
//
// Por que no NAVEGADOR e não no servidor: o container da API já divide 12 GB
// entre Node, DuckDB (6 GB) e o modelo de embeddings. Um interpretador Python
// multiusuário ali dentro exigiria isolamento de verdade (container efêmero,
// socket do Docker exposto, +2–4 GB) — infraestrutura que não existe. No
// navegador o custo de servidor é ZERO e o isolamento é o sandbox do próprio
// browser: sem rede, sem disco do host, e um laço infinito morre com
// worker.terminate() sem afetar mais ninguém.
//
// O modelo é o mesmo do BigQuery: o SQL roda no motor, o Python roda sobre o
// RESULTADO. Cada célula recebe os dados da célula SQL anterior.
/// <reference lib="webworker" />

interface PyodideApi {
  loadPackage(names: string[]): Promise<void>
  runPythonAsync(code: string): Promise<unknown>
  globals: { set(name: string, value: unknown): void }
  setStdout(opts: { batched: (s: string) => void }): void
  setStderr(opts: { batched: (s: string) => void }): void
}

// Pyodide é servido por CDN — são ~10 MB de wasm mais os pacotes sob demanda,
// grandes demais para entrar no pacote da aplicação. Fica cacheado pelo
// navegador depois da primeira vez.
//
// Versão fixada de propósito: o wasm e os pacotes precisam vir do MESMO
// release, e "latest" quebraria o notebook de todo mundo no dia de um upgrade.
const PYODIDE_VERSION = 'v0.26.4'
const CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`

let pyodide: PyodideApi | null = null
const loadedPackages = new Set<string>()

// Pacotes detectados pelo import no código — carregar tudo sempre custaria
// dezenas de MB por execução.
const AVAILABLE = ['pandas', 'numpy', 'scipy', 'scikit-learn', 'matplotlib', 'statsmodels']

function detectPackages(code: string): string[] {
  const found = new Set<string>()
  for (const pkg of AVAILABLE) {
    const mod = pkg === 'scikit-learn' ? 'sklearn' : pkg
    if (new RegExp(`(^|\\n)\\s*(import|from)\\s+${mod}\\b`).test(code)) found.add(pkg)
  }
  // pandas é o caso quase universal aqui: o DataFrame vem pronto na variável
  // `df`, então se a pessoa a usa sem importar nada, ainda precisamos dele.
  if (/\bdf\b/.test(code)) found.add('pandas')
  return [...found]
}

async function ensureRuntime(): Promise<PyodideApi> {
  if (pyodide) return pyodide
  // Import dinâmico do build ESM. `importScripts` NÃO existe em worker de
  // módulo — e este é de módulo, porque o Vite precisa disso para empacotar o
  // arquivo TypeScript. O @vite-ignore impede o Vite de tentar resolver a URL
  // remota em tempo de build.
  const mod = await import(/* @vite-ignore */ `${CDN}pyodide.mjs`) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<PyodideApi>
  }
  pyodide = await mod.loadPyodide({ indexURL: CDN })
  return pyodide
}

// Figuras abertas pela célula → PNG em base64, e fecha todas (a próxima célula
// começa sem gráfico herdado). Teto de 8 por célula: um laço que abre uma
// figura por linha não pode mandar centenas de imagens para a aba.
const FIGURAS = `
def __figuras():
    import sys, io, base64, json
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return "[]"
    saida = []
    for n in plt.get_fignums()[:8]:
        b = io.BytesIO()
        plt.figure(n).savefig(b, format="png", dpi=110, bbox_inches="tight")
        saida.append(base64.b64encode(b.getvalue()).decode())
    plt.close("all")
    return json.dumps(saida)
__figuras()
`

interface RunMessage {
  type: 'run'
  code: string
  /** Resultado da célula SQL anterior — vira `df` (DataFrame) e `rows` (lista). */
  data?: { columns: string[]; rows: Record<string, unknown>[] } | null
}

self.onmessage = async (e: MessageEvent<RunMessage>) => {
  if (e.data?.type !== 'run') return
  const { code, data } = e.data
  const out: string[] = []

  try {
    self.postMessage({ type: 'status', message: pyodide ? 'Executando…' : 'Carregando Python (primeira vez, ~10 MB)…' })
    const py = await ensureRuntime()

    const needed = detectPackages(code).filter((p) => !loadedPackages.has(p))
    if (needed.length) {
      self.postMessage({ type: 'status', message: `Carregando ${needed.join(', ')}…` })
      await py.loadPackage(needed)
      needed.forEach((p) => loadedPackages.add(p))
    }

    // `batched` entrega cada LINHA sem o "\n" do fim; juntar com '' emendava
    // todos os prints numa linha só (e quebrava as tabelas do pandas).
    py.setStdout({ batched: (s) => out.push(s) })
    py.setStderr({ batched: (s) => out.push(s) })

    // Os dados entram como estrutura JS pura e são convertidos em Python — mais
    // barato e mais previsível que serializar para JSON e parsear do outro lado.
    py.globals.set('__rows', data?.rows ?? [])
    py.globals.set('__columns', data?.columns ?? [])

    // Gráfico: o backend padrão do matplotlib no Pyodide desenha no DOM, e
    // worker não tem DOM. Agg desenha em memória; no fim da célula as figuras
    // abertas viram PNG (ver FIGURAS abaixo). plt.show() vira no-op silencioso.
    const prelude = `
import json
import os as _os, sys as _sys, warnings as _warnings
_os.environ["MPLBACKEND"] = "AGG"
if "matplotlib" in _sys.modules:
    _sys.modules["matplotlib"].use("Agg")
_warnings.filterwarnings("ignore", message=".*(non-interactive|non-GUI backend).*")
_warnings.filterwarnings("ignore", message="(?s).*Pyarrow will become a required dependency")
rows = __rows.to_py() if hasattr(__rows, "to_py") else list(__rows)
columns = __columns.to_py() if hasattr(__columns, "to_py") else list(__columns)
df = None
try:
    import pandas as _pd
    df = _pd.DataFrame(rows, columns=columns or None)
except Exception:
    pass
`
    self.postMessage({ type: 'status', message: 'Executando…' })
    const result = await py.runPythonAsync(`${prelude}\n${code}`)

    // Última expressão da célula, quando houver — o comportamento de notebook.
    let repr: string | null = null
    if (result !== undefined && result !== null) {
      try {
        repr = await py.runPythonAsync('str(_)') as string
      } catch {
        repr = String(result)
      }
    }

    // Depois do repr, para não mexer no `_`. Erro aqui não derruba a célula:
    // o texto já está pronto, só o gráfico some.
    let images: string[] = []
    try {
      images = JSON.parse(await py.runPythonAsync(FIGURAS) as string) as string[]
    } catch (err) {
      out.push(`\n[gráfico não gerado: ${(err as Error).message}]`)
    }

    self.postMessage({ type: 'done', stdout: out.join('\n'), repr, images })
  } catch (err) {
    self.postMessage({
      type: 'error',
      stdout: out.join('\n'),
      error: (err as Error).message ?? String(err),
    })
  }
}
