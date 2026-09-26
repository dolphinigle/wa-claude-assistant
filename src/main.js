// Wires config, store, brain, assistant and transport. `npm start` = WhatsApp, `npm run dev` = console REPL.
import { createAssistant } from './assistant.js'
import { createClaudeBrain } from './brain/claude.js'
import { createFakeBrain } from './brain/fake.js'
import { loadConfig } from './config.js'
import { loadKnowledge } from './knowledge.js'
import { BOT_PREFIX } from './owner.js'
import { Store } from './store.js'
import { createConsoleTransport } from './transport/console.js'

const args = process.argv.slice(2)
const useConsole = args.includes('--console')
const useFakeBrain = args.includes('--fake-brain')
const debounceArg = args.find(arg => arg.startsWith('--debounce='))
const OUTAGE_NOTICE_MS = 5 * 60 * 1000

// The console demo keeps its own state so it never touches the real WhatsApp state or audit log.
const overrides = useConsole
  ? { paths: { data: 'data/console' }, debounceMs: debounceArg ? Number(debounceArg.split('=')[1]) : 3000 }
  : {}
const config = loadConfig({ overrides })
const knowledge = loadKnowledge(config.paths.knowledge)
const store = new Store(config.paths.data)
const brain = useFakeBrain ? createFakeBrain() : createClaudeBrain({ config, knowledge })

let assistant
const onMessage = message => assistant.handleMessage(message)
const announce = () => assistant.announce(`${BOT_PREFIX} Assistant online · mode: ${config.mode}${store.paused ? ' · PAUSED' : ''} · brain: ${brain.name}. Send /help for commands.`)

let transport
if (useConsole) {
  transport = createConsoleTransport({ onMessage, onEnd: async () => { await assistant.idle(); await shutdown(0) } })
} else {
  const { createWhatsAppTransport } = await import('./transport/whatsapp.js')
  transport = createWhatsAppTransport({
    config,
    store,
    onMessage,
    onUntriaged: item => assistant.noteUntriaged(item),
    onReady: () => { announce().catch(() => {}) },
    onConnected: ({ outageMs = 0 } = {}) => {
      // Nobody was told while it lasted: the socket was down. Messages from then arrive as backlog (drafts only).
      if (outageMs >= OUTAGE_NOTICE_MS) {
        assistant.announce(`${BOT_PREFIX} ⚠️ WhatsApp was unreachable for ${Math.round(outageMs / 60_000)} min. Messages from that time are drafted, not auto-replied; any older than ${config.backlog.maxAgeMinutes} min were skipped, so check those chats yourself.`).catch(() => {})
      }
      assistant.flushOwnerOutbox().catch(() => {})
    },
    onFatal: verdict => {
      console.error(`\n[whatsapp] STOPPED: ${verdict.reason}. ${verdict.advice ?? ''}`)
      shutdown(1)
    }
  })
}
assistant = createAssistant({ config, store, brain, transport, knowledge })
assistant.recoverInbox()

console.log(`wa-claude-assistant · transport: ${transport.name} · brain: ${brain.name} · mode: ${config.mode.toUpperCase()} · data: ${config.paths.data}`)
if (config.mode === 'live') console.log('LIVE MODE: auto-replies WILL be sent to customers. Set "mode": "shadow" to stop.')
else console.log('Shadow mode: nothing is sent to anyone except your own "Message yourself" chat.')

let shuttingDown = false
async function shutdown (code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nshutting down…')
  brain.close?.()
  await assistant.stop()
  await transport.stop()
  store.save()
  process.exit(code)
}
// A second Ctrl-C while the drain is still waiting (e.g. on a send) exits at once; state.json is always complete.
const onSignal = () => {
  if (!shuttingDown) return shutdown(0)
  console.log('forced exit')
  process.exit(130)
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

await transport.start()
if (useConsole) await announce()
