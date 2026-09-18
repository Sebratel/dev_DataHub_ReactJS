// Sistema de diálogos global — substitui window.confirm/prompt nativos por
// popups no padrão visual do app. Uso via hooks que retornam Promise:
//   const confirm = useConfirm()
//   if (!(await confirm({ message: 'Excluir?', danger: true }))) return
//   const prompt = usePrompt()
//   const nome = await prompt({ title: 'Novo dashboard', label: 'Nome' })
//   if (!nome) return
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { X, AlertTriangle } from 'lucide-react'

interface ConfirmOpts {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
interface PromptOpts {
  title?: string
  label?: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
}
interface DialogCtx {
  confirm: (o: ConfirmOpts) => Promise<boolean>
  prompt: (o: PromptOpts) => Promise<string | null>
}

const Ctx = createContext<DialogCtx | null>(null)
export function useConfirm(): DialogCtx['confirm'] {
  const c = useContext(Ctx)
  if (!c) throw new Error('useConfirm precisa do <DialogProvider>')
  return c.confirm
}
export function usePrompt(): DialogCtx['prompt'] {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePrompt precisa do <DialogProvider>')
  return c.prompt
}

const overlay = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 animate-fade-in'
const card = 'w-full max-w-md rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900'
const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

export function DialogProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)
  const [promptState, setPromptState] = useState<(PromptOpts & { resolve: (v: string | null) => void }) | null>(null)
  const [value, setValue] = useState('')

  const confirm = useCallback(
    (o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })),
    [],
  )
  const prompt = useCallback(
    (o: PromptOpts) => new Promise<string | null>((resolve) => { setValue(o.initial ?? ''); setPromptState({ ...o, resolve }) }),
    [],
  )

  const closeConfirm = (v: boolean) => { confirmState?.resolve(v); setConfirmState(null) }
  const closePrompt = (v: string | null) => { promptState?.resolve(v); setPromptState(null) }

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}

      {confirmState && (
        <Backdrop onCancel={() => closeConfirm(false)}>
          <div className="mb-3 flex items-start gap-3">
            {confirmState.danger && (
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/50">
                <AlertTriangle size={16} />
              </span>
            )}
            <div className="min-w-0">
              <h2 className="font-semibold">{confirmState.title ?? 'Confirmar'}</h2>
              {/* pre-line: uma confirmação que enumera consequências (quantos
                  conjuntos recarregam, qual agendamento entra) precisa de
                  parágrafo. Sem isto, as quebras viravam um bloco único. */}
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-zinc-500">{confirmState.message}</p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => closeConfirm(false)}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              {confirmState.cancelLabel ?? 'Cancelar'}
            </button>
            <button autoFocus onClick={() => closeConfirm(true)}
              className={confirmState.danger
                ? 'rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700'
                : 'rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover'}>
              {confirmState.confirmLabel ?? 'Confirmar'}
            </button>
          </div>
        </Backdrop>
      )}

      {promptState && (
        <Backdrop onCancel={() => closePrompt(null)}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{promptState.title ?? 'Informe um valor'}</h2>
            <button onClick={() => closePrompt(null)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
          </div>
          {promptState.label && <span className="mb-1 block text-xs text-zinc-500">{promptState.label}</span>}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) closePrompt(value.trim()) }}
            placeholder={promptState.placeholder}
            className={inp}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => closePrompt(null)}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Cancelar
            </button>
            <button onClick={() => value.trim() && closePrompt(value.trim())} disabled={!value.trim()}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {promptState.confirmLabel ?? 'Confirmar'}
            </button>
          </div>
        </Backdrop>
      )}
    </Ctx.Provider>
  )
}

// Fundo com fechar por clique-fora e Esc; para de propagar o clique interno.
function Backdrop({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className={overlay} onClick={onCancel}>
      <div className={card} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}
