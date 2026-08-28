// ─────────────────────────────────────────────────────────────────────────
// Verificação do ID token do Firebase — feita AQUI, com a chave pública do
// Google, em vez de perguntar ao Google a cada login.
//
// É esta a diferença que faz o HUBBI sobreviver ao firewall e o Data Hub não.
// O access_token do Google é opaco: só o Google sabe de quem é, então a API
// precisava chamar googleapis.com/userinfo em toda validação. O ID token do
// Firebase é um JWT ASSINADO: dentro dele já vem o e-mail, e a assinatura prova
// que foi o Google que emitiu. Basta ter a chave pública — e ela vale horas.
//
// Resultado prático: depois de buscar os certificados uma vez, a API valida
// login sem tocar na rede. Se a saída para o Google cair, quem já está logado
// continua trabalhando e quem tem um token válido continua entrando.
//
// Por que não `firebase-admin`: ele faria exatamente isto, mas arrasta uma
// árvore de dependências grande (google-auth-library, gcp-metadata, gtoken…)
// para uma imagem que roda sob tsx, sem build. O que precisamos é uma função
// de ~80 linhas usando node:crypto.
import { createVerify, createPublicKey, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { config } from '../../core/config.js'

// Onde o Google publica as chaves públicas que assinam os ID tokens do Firebase.
const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

// Cópia em disco dos certificados. Sem isto, um restart do container com a
// saída bloqueada deixaria a API sem conseguir validar NADA — justamente o
// cenário que este módulo existe para evitar.
const CACHE_FILE = join(tmpdir(), 'datahub-firebase-certs.json')

interface CertCache { keys: Record<string, string>; fetchedAt: number }

let memo: CertCache | null = null
let inFlight: Promise<CertCache> | null = null

const SOFT_TTL_MS = 6 * 60 * 60 * 1000   // renova depois disso, se der
const HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // além disso, não confia mais

function loadFromDisk(): CertCache | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CertCache
    return c.keys && Object.keys(c.keys).length ? c : null
  } catch { return null }
}

function saveToDisk(c: CertCache): void {
  try {
    mkdirSync(join(CACHE_FILE, '..'), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(c))
  } catch { /* cache é otimização; falhar aqui não pode derrubar login */ }
}

async function fetchCerts(): Promise<CertCache> {
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`certificados do Google responderam ${r.status}`)
  const keys = (await r.json()) as Record<string, string>
  if (!keys || !Object.keys(keys).length) throw new Error('lista de certificados vazia')
  const c: CertCache = { keys, fetchedAt: Date.now() }
  saveToDisk(c)
  return c
}

/**
 * Certificados válidos. A ordem importa: serve o que está em memória, renova em
 * segundo plano quando envelhece, e SÓ bloqueia esperando a rede quando não há
 * nada utilizável. Uma renovação que falha não invalida o que já temos.
 */
async function getCerts(): Promise<CertCache> {
  if (!memo) memo = loadFromDisk()

  const age = memo ? Date.now() - memo.fetchedAt : Infinity
  if (memo && age < SOFT_TTL_MS) return memo

  if (memo && age < HARD_TTL_MS) {
    // Envelhecido mas ainda utilizável: renova sem segurar o login.
    if (!inFlight) {
      inFlight = fetchCerts()
        .then((c) => { memo = c; return c })
        .catch((e) => {
          console.warn(`[auth] não consegui renovar os certificados do Google (${(e as Error).message}); ` +
            'seguindo com os que estão em cache.')
          return memo!
        })
        .finally(() => { inFlight = null })
    }
    return memo
  }

  // Sem nada utilizável: aqui não tem como não esperar.
  if (!inFlight) inFlight = fetchCerts().then((c) => { memo = c; return c }).finally(() => { inFlight = null })
  return inFlight
}

export interface FirebaseClaims {
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
}

const b64urlToBuf = (s: string) => Buffer.from(s, 'base64url')

/** Extrai a chave pública de um certificado X.509 em PEM. */
function publicKeyOf(certPem: string): ReturnType<typeof createPublicKey> {
  // X509Certificate valida o PEM de verdade; createPublicKey direto no
  // certificado não funciona em todas as versões do Node.
  return new X509Certificate(certPem).publicKey
}

/**
 * Valida o ID token e devolve as claims, ou null se algo não fecha.
 * Nunca lança por token inválido — só por falha de infraestrutura.
 */
export async function verifyFirebaseIdToken(token: string): Promise<FirebaseClaims | null> {
  const projectId = config.auth.firebaseProjectId
  if (!projectId) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSig] = parts

  let header: { alg?: string; kid?: string }
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64urlToBuf(rawHeader).toString('utf8')) as typeof header
    payload = JSON.parse(b64urlToBuf(rawPayload).toString('utf8')) as Record<string, unknown>
  } catch { return null }

  // O Firebase assina ID token com RS256. Aceitar outro algoritmo abriria a
  // porta clássica do "alg: none".
  if (header.alg !== 'RS256' || !header.kid) return null

  // Emissor e público têm de ser ESTE projeto: sem isso, um token válido de
  // qualquer outro projeto Firebase do mundo entraria aqui.
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null
  if (payload.aud !== projectId) return null

  const now = Math.floor(Date.now() / 1000)
  const exp = Number(payload.exp ?? 0)
  const iat = Number(payload.iat ?? 0)
  if (!exp || exp <= now) return null
  // 5 min de tolerância para relógio adiantado do servidor.
  if (iat && iat > now + 300) return null

  const certs = await getCerts()
  const pem = certs.keys[header.kid]
  if (!pem) return null

  const ok = createVerify('RSA-SHA256')
    .update(`${rawHeader}.${rawPayload}`)
    .verify(publicKeyOf(pem), b64urlToBuf(rawSig))
  if (!ok) return null

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
  if (!email) return null

  return {
    email,
    emailVerified: payload.email_verified !== false,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

/** Só para o teste de fumaça: injeta certificados sem tocar na rede. */
export function __setCertsForTest(keys: Record<string, string>): void {
  memo = { keys, fetchedAt: Date.now() }
}
