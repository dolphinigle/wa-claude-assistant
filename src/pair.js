// `npm run pair`: the go/no-go check. Shows a QR, waits for the link to open (or a classified failure),
// prints PASS/FAIL with the next step, and exits. It never logs out, so auth/ is kept on PASS.
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { createBaileysLogger, createBaileysSocket, renderQr } from './transport/whatsapp.js'
import { classifyDisconnect, getMeIds } from './transport/wa-normalize.js'

const TIMEOUT_MS = 5 * 60 * 1000
const MAX_RESTARTS = 3
const CREDS_FLUSH_MS = 3000

/**
 * Connecting on an existing link is not a harmless check: the socket goes active, Baileys decrypts and acks
 * everything WhatsApp queued for this device, and this script has no message handler, so `npm start` would never
 * see those messages. Only a fresh pairing, or an explicit --force, may connect.
 */
export function checkExistingLink ({ alreadyLinked, force, authDir }) {
  if (!alreadyLinked) return { proceed: true }
  if (force) return { proceed: true, warning: `auth found in ${authDir}; connecting anyway (--force). Messages WhatsApp queued for this device while the assistant was stopped are consumed by this run and will not be triaged.` }
  return {
    proceed: false,
    message: [
      `auth found in ${authDir}: this device is already linked. Not connecting.`,
      'Re-running pair would consume the messages WhatsApp queued for this device while the assistant was stopped;',
      'they would never be triaged. Run `npm start` instead: it verifies the link and handles that backlog.',
      'To link again from scratch: stop the assistant, rm -rf auth, npm run pair.',
      'To connect anyway: npm run pair -- --force'
    ].join('\n')
  }
}

/**
 * Pairing is the first connection: from its 'open' on, WhatsApp queues messages for this device, so the history floor
 * starts here, not at the first `npm start` (which would skip what arrived in between). Set once, like the transport.
 */
export function seedHistoryFloorOnPairing (dataDir, nowMs = Date.now()) {
  const store = new Store(dataDir)
  store.seedHistoryFloor(Math.floor(nowMs / 1000))
  return store.historyFloorTs
}

function main () {
  const config = loadConfig()
  if (config.transport !== 'baileys') {
    console.log(`npm run pair links the Baileys device only; config.transport is "${config.transport}", which needs no pairing. Nothing done.`)
    process.exit(1)
  }
  const authDir = config.paths.auth
  const alreadyLinked = existsSync(path.join(authDir, 'creds.json'))
  const guard = checkExistingLink({ alreadyLinked, force: process.argv.includes('--force'), authDir })
  if (!guard.proceed) {
    console.log(guard.message)
    process.exit(1)
  }
  const logger = createBaileysLogger()
  console.log(guard.warning ?? `No auth yet. A QR code will appear; link it from your phone within ~60 s.\nauth dir: ${authDir} (mode 0700, never commit or share it)`)

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
      console.log('Next: npm run selftest, then npm start (shadow mode) right away: from now on WhatsApp queues messages for')
      console.log('this device, and only the running assistant should receive them. Check that the "Assistant online" notice')
      console.log('lands in "Message yourself".')
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
        try {
          seedHistoryFloorOnPairing(config.paths.data)
        } catch (error) {
          console.log(`(could not record the pairing time in ${config.paths.data}: ${error.message}; messages until the first npm start may be skipped)`)
        }
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
}

// Run only as `node src/pair.js`; importing it (tests) must never open a socket. realpath: the ESM loader resolves
// symlinks in the entry path, argv[1] does not.
const invokedDirectly = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false } }
if (invokedDirectly()) main()
