// Tela de login no padrão visual do churn_mvp (Operação Sebratel):
// hero em tela cheia + decoração âmbar + card creme com botão âmbar.
// O fluxo de autenticação é o do Data Hub (GSI token client + /auth/me).
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion'
import { AlertCircle, Info, Loader2, Lock, Shield } from 'lucide-react'
import type { SessionUser } from '@datahub/shared'
import { login as loginProvider } from '@/store/authProvider'
import { describeAuthError, type AuthErrorInfo } from '@/store/firebaseAuth'
import { useAuthStore } from '@/store/authStore'
import { api } from '@/lib/api'

const HERO = '/login-hero.png'
const LOGO = '/logo-circular-sebratel.png'
const EASE = [0.22, 1, 0.36, 1] as const

// Marca colorida do Google (SVG) — mesmo padrão do churn_mvp
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.25 1.3-1 2.4-2.1 3.1l3.4 2.6c2-1.8 3.1-4.5 3.1-7.7 0-.75-.07-1.5-.2-2.2H12z" />
      <path fill="#34A853" d="M5.8 14.1l-.9.7-2.5 1.9C4.2 20.8 7.9 23 12 23c3 0 5.5-1 7.3-2.7l-3.4-2.6c-.9.6-2.1 1-3.9 1-3 0-5.5-2-6.4-4.7z" />
      <path fill="#FBBC05" d="M5.5 9.3 2.9 7.1C1.1 10.4 1.1 14.3 2.9 17.6l2.6-2c-.4-1.2-.4-2.5 0-3.7z" />
      <path fill="#4285F4" d="M12 5.8c1.7 0 3.2.6 4.4 1.8l3.3-3.3C16.5 2.1 14.4 1 12 1 7.9 1 4.2 3.2 2.9 7.1l2.6 2C6.5 7.4 9.1 5.8 12 5.8z" />
    </svg>
  )
}

// Camadas decorativas âmbar/rede sobre o hero
function HeroAmbientDecor({ reduced }: { reduced: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {!reduced && (
        <>
          <motion.div
            className="absolute -left-[15%] top-[18%] h-[min(85vw,520px)] w-[min(85vw,520px)] rounded-full bg-primary/20 blur-[88px]"
            animate={{ opacity: [0.28, 0.48, 0.28], scale: [1, 1.06, 1] }}
            transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute -right-[8%] bottom-[12%] h-[min(70vw,420px)] w-[min(70vw,420px)] rounded-full bg-secondary/15 blur-[72px]"
            animate={{ opacity: [0.22, 0.42, 0.22], x: [0, -12, 0], y: [0, 8, 0] }}
            transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
          />
        </>
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_75%_55%_at_45%_42%,rgba(255,176,0,0.14),transparent_68%)] mix-blend-screen" />
      <svg className="absolute inset-0 h-full w-full opacity-[0.18] mix-blend-screen" viewBox="0 0 1200 780" preserveAspectRatio="xMidYMid slice">
        <path d="M0,520 Q280,380 520,460 T920,400 T1200,360" fill="none" stroke="rgba(255,184,0,0.65)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
        <path d="M80,620 Q420,520 720,560 T1180,480" fill="none" stroke="rgba(255,143,0,0.45)" strokeWidth="1" opacity="0.8" vectorEffect="non-scaling-stroke" />
        <path d="M200,180 Q520,280 780,200 T1120,240" fill="none" stroke="rgba(255,184,0,0.35)" strokeWidth="0.85" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const setUser = useAuthStore((s) => s.setUser)
  const reduced = !!useReducedMotion()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AuthErrorInfo | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  async function handleGoogle() {
    setBusy(true)
    setError(null)
    try {
      await loginProvider()
      // /auth/me provisiona o usuário no tenant e devolve papéis.
      const { user } = await api<{ user: SessionUser }>('/api/v1/auth/me')
      setUser(user)
      navigate('/', { replace: true })
    } catch (e) {
      // A causa vira frase acionável; o texto cru fica atrás de "detalhes".
      setError(describeAuthError(e))
      setShowDetail(false)
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-svh w-full overflow-hidden bg-[#0c0a08] text-on-surface">
      {/* Hero em tela inteira + zoom imperceptível */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute inset-[-3%] bg-cover bg-[center_32%] bg-no-repeat sm:bg-[left_28%_center] lg:bg-[left_22%_center]"
          style={{ backgroundImage: `url(${HERO})` }}
          animate={reduced ? undefined : { scale: [1, 1.032, 1] }}
          transition={{ duration: 36, repeat: Infinity, ease: 'easeInOut' }}
        />
        <HeroAmbientDecor reduced={reduced} />
        {/* scrims reforçados para legibilidade do texto e do card */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-[#0f0d0b]/70" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-black/40" />
        <div className="absolute inset-0 bg-black/15" />
      </div>

      <div className="relative z-10 flex min-h-svh w-full flex-col pb-16 lg:flex-row lg:items-center lg:pb-20">
        {/* Bloco de marca */}
        <div className="order-1 flex flex-col gap-3 px-4 pt-10 text-[#fff] lg:min-h-svh lg:flex-1 lg:justify-end lg:pb-32 lg:pl-10 lg:pr-6 lg:pt-0 xl:pl-14">
          <motion.div
            className="flex items-center gap-3 drop-shadow-md"
            initial={reduced ? false : { opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <img src={LOGO} alt="" width={44} height={44} className="h-11 w-11 rounded-full object-contain ring-1 ring-[#fff]/40 shadow-lg" aria-hidden />
            <span className="text-[13px] font-extrabold uppercase tracking-[0.24em] text-[#fff] drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)] sm:text-[14px]">Data Hub Sebratel</span>
          </motion.div>
          <motion.h2
            className="max-w-xl text-balance text-[17px] font-bold leading-[1.15] tracking-tight text-[#fff] drop-shadow-[0_2px_12px_rgba(0,0,0,0.75)] sm:text-[19px] lg:text-[2rem] xl:text-4xl"
            initial={reduced ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: EASE }}
          >
            Todos os dados da operação, <span className="text-[#FFC107]">em um só lugar.</span>
          </motion.h2>
          <motion.p
            className="max-w-md text-sm leading-relaxed text-[#fff] drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)] sm:text-[13px]"
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.16, ease: EASE }}
          >
            Conjuntos de dados, dashboards e IA — sem depender de planilhas.
          </motion.p>
        </div>

        {/* Card de login */}
        <div className="order-2 flex w-full flex-1 flex-col items-center justify-center px-4 py-10 sm:px-4 lg:w-[min(100%,460px)] lg:flex-none lg:px-8 xl:pr-16 motion-safe:-translate-x-5 lg:motion-safe:-translate-x-12">
          <motion.div
            className="relative z-10 w-full max-w-[440px]"
            initial={reduced ? false : { opacity: 0, y: 36, scale: 0.96, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.58, ease: EASE, delay: 0.06 }}
          >
            <motion.div
              className="relative overflow-hidden rounded-2xl border border-[#fff]/60 bg-[#FBFAF5] shadow-[0_36px_72px_-12px_rgba(0,0,0,0.62)] ring-1 ring-black/5 sm:rounded-3xl"
              animate={error && !reduced ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/45 to-transparent" />

              <div className="relative space-y-4 p-7 sm:p-8">
                <header className="space-y-2">
                  <span className="inline-flex rounded-full border border-amber-300/70 bg-amber-100 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-900">
                    Data Hub Sebratel
                  </span>
                  <h1 className="text-[17px] font-bold tracking-tight text-on-surface sm:text-[1.65rem]">Acessar plataforma</h1>
                  <p className="text-sm leading-relaxed text-neutral-700">
                    Acesso com conta Google para controle de permissões por papel.
                  </p>
                </header>

                {/* Domínio liberado nesta fase */}
                <div className="rounded-2xl border border-amber-300/80 bg-[#FFFBEB] p-3 shadow-sm">
                  <div className="flex gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/50 bg-amber-100/80 text-primary">
                      <Shield className="h-5 w-5" strokeWidth={2} aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-sm text-on-surface">
                        Domínio liberado nesta fase:{' '}
                        <span className="font-semibold text-on-surface">@sebratel.com.br</span>
                      </p>
                      <a
                        href="mailto:?subject=Pol%C3%ADtica%20de%20acesso%20%E2%80%94%20Data%20Hub%20Sebratel"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary transition hover:text-secondary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        <Info className="h-3.5 w-3.5" aria-hidden />
                        Política de acesso
                      </a>
                    </div>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {error && (
                    <motion.div
                      role="alert"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                      className="rounded-xl border border-rose-200/90 bg-rose-50/95 px-3 py-2.5 text-sm text-rose-900 shadow-sm"
                    >
                      <div className="flex gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                        {/* min-w-0 + break-words: sem isso a URL longa do erro do
                            Google estoura a caixa e some justamente a parte que
                            explica a causa. */}
                        <span className="min-w-0 break-words">{error.message}</span>
                      </div>
                      {error.detail && error.detail !== error.message && (
                        <div className="mt-1.5 pl-6">
                          <button
                            type="button"
                            onClick={() => setShowDetail((v) => !v)}
                            className="text-xs font-medium text-rose-700 underline underline-offset-2"
                          >
                            {showDetail ? 'ocultar detalhes técnicos' : 'ver detalhes técnicos'}
                          </button>
                          {showDetail && (
                            <div className="mt-1.5">
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white/70 p-2 text-[11px] leading-relaxed">
                                {error.detail}
                              </pre>
                              <button
                                type="button"
                                onClick={() => void navigator.clipboard.writeText(error.detail)}
                                className="mt-1 text-xs font-medium text-rose-700 underline underline-offset-2"
                              >
                                copiar
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                <motion.button
                  type="button"
                  onClick={handleGoogle}
                  disabled={busy}
                  aria-busy={busy}
                  whileHover={reduced || busy ? undefined : { scale: 1.02, y: -1 }}
                  whileTap={reduced || busy ? undefined : { scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                  className="group relative flex min-h-[44px] w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-[#FFB800] px-4 py-3.5 text-sm font-semibold text-on-surface shadow-md transition-shadow hover:bg-[#e6a800] hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="relative z-10 h-5 w-5 animate-spin text-on-surface" aria-hidden />
                  ) : (
                    <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#fff] shadow-sm ring-1 ring-black/5">
                      <GoogleMark className="h-5 w-5" />
                    </span>
                  )}
                  <span className="relative z-10">{busy ? 'A autenticar…' : 'Entrar com Google'}</span>
                </motion.button>

                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-neutral-200" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">ou</span>
                  <div className="h-px flex-1 bg-neutral-200" />
                </div>

                <p className="text-center text-[11px] text-on-surface-variant">
                  <a
                    href="mailto:?subject=Acesso%20Data%20Hub%20Sebratel%20%E2%80%94%20suporte&body=Descreva%20o%20problema%20e%20o%20seu%20e-mail%20corporativo."
                    className="inline-flex items-center justify-center gap-1.5 font-medium text-primary underline-offset-2 transition hover:text-secondary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Info className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
                    Problemas para acessar?
                  </a>
                </p>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>

      <footer className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 border-t border-[#fff]/10 bg-black/55 py-2.5 text-center text-[11px] text-[#fff]/90 backdrop-blur-md supports-[backdrop-filter]:bg-black/40">
        <span className="inline-flex items-center justify-center gap-2 px-4">
          <Lock className="h-3.5 w-3.5 shrink-0 opacity-90" strokeWidth={2} aria-hidden />
          Ambiente seguro e monitorado.
        </span>
      </footer>
    </div>
  )
}
