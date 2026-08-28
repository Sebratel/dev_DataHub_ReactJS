// Verificação do login por ID token do Firebase.
//
// Este é código de SEGURANÇA: um erro aqui não aparece como tela quebrada, e sim
// como alguém entrando com um token que não deveria valer. Por isso o teste não
// se contenta em provar que um token bom passa — ele tenta as fraudes clássicas
// e exige que TODAS sejam recusadas.
//
//   npm run auth:smoke --workspace apps/api
//
// Usa um certificado autoassinado gerado na hora pelo openssl, injetado no lugar
// dos certificados do Google. Nada de rede.
import { execFileSync } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyFirebaseIdToken, __setCertsForTest } from '../modules/auth/firebaseToken.js'
import { config } from '../core/config.js'

const PROJECT = config.auth.firebaseProjectId || 'projeto-de-teste'
if (!config.auth.firebaseProjectId) {
  // O módulo lê o projeto de config; sem env definido, aponta para o de teste.
  ;(config.auth as { firebaseProjectId: string }).firebaseProjectId = PROJECT
}

const dir = mkdtempSync(join(tmpdir(), 'authsmoke-'))
let failures = 0
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? 'ok    ' : 'FALHA '} ${label}`)
  if (!ok) failures++
}

function makeCert(): { keyPem: string; certPem: string } {
  const keyPath = join(dir, 'k.pem')
  const certPath = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=teste'],
    { stdio: 'ignore' })
  return { keyPem: readFileSync(keyPath, 'utf8'), certPem: readFileSync(certPath, 'utf8') }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')

function sign(keyPem: string, header: object, payload: object): string {
  const data = `${b64(header)}.${b64(payload)}`
  const sig = createSign('RSA-SHA256').update(data).sign(keyPem).toString('base64url')
  return `${data}.${sig}`
}

const now = () => Math.floor(Date.now() / 1000)
const validPayload = (over: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: 'uid-123',
  iat: now() - 60,
  exp: now() + 3600,
  email: 'Misael.Cruz@Sebratel.com.br',
  email_verified: true,
  name: 'Misael',
  picture: 'https://exemplo/foto.png',
  ...over,
})

try {
  const { keyPem, certPem } = makeCert()
  const outro = makeCert() // segunda identidade: chave que NÃO é a do Google
  __setCertsForTest({ kid1: certPem })
  const H = { alg: 'RS256', kid: 'kid1', typ: 'JWT' }

  console.log('\nDeve ACEITAR:')
  const bom = await verifyFirebaseIdToken(sign(keyPem, H, validPayload()))
  check(bom !== null, 'token válido é aceito')
  check(bom?.email === 'misael.cruz@sebratel.com.br', 'e-mail normalizado para minúsculas')
  check(bom?.name === 'Misael' && !!bom?.picture, 'nome e foto extraídos')
  check(bom?.emailVerified === true, 'email_verified lido')

  console.log('\nDeve RECUSAR:')
  const recusa = async (label: string, token: string) =>
    check((await verifyFirebaseIdToken(token)) === null, label)

  // A fraude clássica: trocar o conteúdo mantendo a assinatura antiga.
  const t = sign(keyPem, H, validPayload())
  const [h, , s] = t.split('.')
  const adulterado = `${h}.${b64(validPayload({ email: 'invasor@sebratel.com.br' }))}.${s}`
  await recusa('payload adulterado (assinatura não bate)', adulterado)

  await recusa('assinado por outra chave', sign(outro.keyPem, H, validPayload()))
  await recusa('emissor de outro projeto',
    sign(keyPem, H, validPayload({ iss: 'https://securetoken.google.com/projeto-alheio' })))
  await recusa('audience de outro projeto', sign(keyPem, H, validPayload({ aud: 'projeto-alheio' })))
  await recusa('expirado', sign(keyPem, H, validPayload({ exp: now() - 10 })))
  await recusa('emitido no futuro', sign(keyPem, H, validPayload({ iat: now() + 3600 })))
  await recusa('kid desconhecido', sign(keyPem, { ...H, kid: 'inexistente' }, validPayload()))
  await recusa('sem e-mail', sign(keyPem, H, validPayload({ email: undefined })))

  // "alg: none" — o ataque de manual: se o verificador confiar no cabeçalho
  // para escolher o algoritmo, um token sem assinatura nenhuma passa.
  await recusa('alg: none, sem assinatura',
    `${b64({ alg: 'none', kid: 'kid1' })}.${b64(validPayload())}.`)

  // HS256 usando o CERTIFICADO como segredo: o outro ataque clássico de
  // confusão de algoritmo (assimétrico tratado como simétrico).
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  void privateKey
  await recusa('algoritmo trocado para HS256',
    `${b64({ alg: 'HS256', kid: 'kid1' })}.${b64(validPayload())}.assinatura-qualquer`)

  await recusa('lixo', 'nao-e-um-jwt')
  await recusa('duas partes só', 'aaa.bbb')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} verificação(ões) falharam.\n` : '\nTudo certo.\n')
process.exit(failures ? 1 : 0)

// evita aviso de import não usado quando o teste roda sem escrever arquivos
void writeFileSync
