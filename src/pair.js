// `npm run pair`: the go/no-go check. Shows a QR, waits for the link to open (or a classified failure),
// prints PASS/FAIL with the next step, and exits. It never logs out, so auth/ is kept on PASS.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { createBaileysLogger, createBaileysSocket, renderQr } from './transport/whatsapp.js'
import { classifyDisconnect, getMeIds } from './transport/wa-normalize.js'

const TIMEOUT_MS = 5 * 60 * 1000
const MAX_RESTARTS = 3
const CREDS_FLUSH_MS = 3000

const config = loadConfig()
const authDir = config.paths.auth
const logger = createBaileysLogger()
const alreadyLinked = existsSync(path.join(authDir, 'creds.json'))

console.log(alreadyLinked
  ? `auth found in ${authDir}; connecting to verify the existing link…`
  : `No auth yet. A QR code will appear; link it from your phone within ~60 s.\nauth dir: ${authDir} (mode 0700, never commit or share it)`)

let sock
let restarts = 0
let finished = false

function finish (pass, detail, advice) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  console.log('')
  if (pass) {
    console.log(`PASS: ${detail}`)
    console.log('Next: npm run selftest, then npm start (shadow mode). Check that the "Assistant online" notice lands in "Message yourself".')
  } else {
    console.log(`FAIL: ${detail}`)
    if (advice) console.log(`Next: ${advice}`)
    console.log('If the phone accepted the scan but linking never completes (or the socket closes right after the scan), this is')
    console.log('likely Baileys #2737. Fallback: PR #2765 as a git dependency pinned by commit SHA, after reviewing its diff;')
    console.log('see README "Pairing fallback". If that fails too, the notes say switch to whatsapp-web.js.')
  }
  // Give saveCreds a moment to flush; end() closes the socket without unlinking the device.
  setTimeout(async () => {
    try { await sock?.end(undefined) } catch {}
    process.exit(pass ? 0 : 1)
  }, pass ? CREDS_FLUSH_MS : 200)
}

const deadline = setTimeout(() => finish(false, 'timed out after 5 minutes without an open connection.', 'Run `npm run pair` again.'), TIMEOUT_MS)

async function connect () {
  sock = await createBaileysSocket({ authDir, logger })
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !finished) renderQr(qr)
    if (connection === 'open') {
      finish(true, `linked and connected as ${getMeIds(sock.user).join(' / ')}${sock.user?.name ? ` (${sock.user.name})` : ''}. Auth kept in ${authDir}.`)
    }
    if (connection === 'close' && !finished) {
      const error = lastDisconnect?.error
      const code = error?.output?.statusCode
      const verdict = classifyDisconnect(code, error?.message)
      // 515 right after the scan is the normal "restart required" step of pairing.
      if (verdict.action === 'recreate_now' && restarts < MAX_RESTARTS) {
        restarts++
        console.log(`(status ${code}: ${verdict.reason}, reconnecting as part of pairing…)`)
        connect().catch(setupError => finish(false, `socket setup failed: ${setupError.message}`))
        return
      }
      finish(false, `connection closed with status ${code ?? 'none'} (${verdict.reason})${error?.message ? `: ${error.message}` : ''}.`,
        verdict.advice ?? 'Delete auth/ (rm -rf auth) and run `npm run pair` again once.')
    }
  })
}

process.on('SIGINT', () => finish(false, 'interrupted.', 'Run `npm run pair` again when ready.'))
connect().catch(error => finish(false, `socket setup failed: ${error.message}`))
