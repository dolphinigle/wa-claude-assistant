// `npm run tunnel`: a public https URL for the Cloud API webhook, from cloudflared's free quick tunnel (no account).
// Meta needs a valid TLS certificate on the callback URL, which a tunnel gives a laptop. Prints the callback URL and
// the verify token to paste into the Meta app (WhatsApp → Configuration). The URL changes on every run.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'

// Downloads stay out of /tmp (RAM on the owner's machine) and out of the repo.
const BIN_DIR = path.join(os.homedir(), 'copilot', 'research', 'wa-claude-assistant', 'bin')
const LOCAL_BIN = path.join(BIN_DIR, 'cloudflared')
const RELEASE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/ // api.trycloudflare.com is where it asks for one

const works = bin => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0

async function findCloudflared () {
  if (works('cloudflared')) return 'cloudflared'
  if (existsSync(LOCAL_BIN) && works(LOCAL_BIN)) return LOCAL_BIN
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`cloudflared is not installed; get it for ${process.platform}/${process.arch} from https://github.com/cloudflare/cloudflared/releases`)
  }
  console.log(`cloudflared not found; downloading the official linux-amd64 release to ${LOCAL_BIN} …`)
  const response = await fetch(RELEASE_URL, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} from ${RELEASE_URL}`)
  mkdirSync(BIN_DIR, { recursive: true })
  const partial = `${LOCAL_BIN}.partial`
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()))
  chmodSync(partial, 0o755)
  renameSync(partial, LOCAL_BIN)
  if (!works(LOCAL_BIN)) throw new Error(`the downloaded ${LOCAL_BIN} does not run`)
  return LOCAL_BIN
}

async function main () {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`config: ${error.message}`)
    process.exit(1)
  }
  const { port = 3000, webhookPath = '/webhook', verifyToken } = config.cloudApi ?? {}
  if (config.transport !== 'cloud-api') console.log('Note: config.transport is not "cloud-api"; npm start will not listen for the webhook.')
  const bin = await findCloudflared()
  // 127.0.0.1, not localhost: the webhook listens on IPv4 loopback only, and localhost may resolve to ::1 first.
  const origin = `http://127.0.0.1:${port}`
  console.log(`cloudflared: ${bin}\nStarting a quick tunnel to ${origin} (Ctrl-C stops it; the URL changes on every run) …`)

  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', origin], { stdio: ['ignore', 'pipe', 'pipe'] })
  let shown = false
  let output = '' // a chunk may end mid-URL
  const scan = chunk => {
    if (shown) return
    output = (output + chunk).slice(-4096)
    const match = output.match(TUNNEL_URL)
    if (!match) return
    shown = true
    console.log([
      '',
      `Public URL:    ${match[0]}`,
      `Callback URL:  ${match[0]}${webhookPath}`,
      `Verify token:  ${verifyToken ?? '(not set: put any long random string in config.local.json cloudApi.verifyToken)'}`,
      '',
      'Meta app → WhatsApp → Configuration → Webhook → Edit: paste both, "Verify and save" (npm start must be running),',
      'then subscribe the "messages" webhook field. Keep this window open while the bot runs.',
      ''
    ].join('\n'))
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan) // cloudflared prints the URL on stderr
  child.on('exit', code => {
    if (!shown) console.error(`cloudflared exited (code ${code}) before printing a URL; run \`${bin} tunnel --url ${origin}\` to see why.`)
    process.exit(code ?? 0)
  })
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
