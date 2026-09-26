// REPL stand-in for WhatsApp (`npm run dev`). Same interface as the WhatsApp transport, including the echo of
// the bot's own sends, so the loop guard is exercised the way it is live.
import readline from 'node:readline'

export const SELF_CHAT_ID = 'me@console'
const chatIdFor = name => `${name.toLowerCase()}@console`

export const CONSOLE_USAGE = `Type lines like:
  alice: jam berapa buka?     incoming message from contact "alice"
  me@alice: bentar ya kak     you typing in alice's chat (starts human takeover)
  me: /ok 1                   you typing in "Message yourself" (owner commands)
  quit                        exit`

/** Parses one REPL line into an inbound message shape (without id/timestamp), or {command}. */
export function parseConsoleLine (line) {
  const text = line.trim()
  if (!text) return null
  if (/^(quit|exit)$/i.test(text)) return { command: 'quit' }
  if (/^(help|\?)$/i.test(text)) return { command: 'help' }
  let match = text.match(/^me:\s*([\s\S]+)$/i)
  if (match) return { chatId: SELF_CHAT_ID, fromMe: true, isSelfChat: true, text: match[1] }
  match = text.match(/^me@([\w.-]+):\s*([\s\S]+)$/i)
  if (match) return { chatId: chatIdFor(match[1]), fromMe: true, isSelfChat: false, text: match[2] }
  match = text.match(/^([\w.-]+):\s*([\s\S]+)$/)
  if (match) return { chatId: chatIdFor(match[1]), fromMe: false, isSelfChat: false, senderName: match[1], text: match[2] }
  return { command: 'unparsed' }
}

export function createConsoleTransport ({ onMessage, onEnd, input = process.stdin, output = process.stdout, now = () => Date.now() }) {
  const history = new Map()
  let counter = 0
  let rl
  const print = text => output.write(`${text}\n`)
  const remember = (chatId, message) => {
    const list = history.get(chatId) ?? []
    list.push(message)
    history.set(chatId, list.slice(-50))
  }

  const deliver = message => {
    remember(message.chatId, { id: message.id, fromMe: message.fromMe, text: message.text, timestamp: message.timestamp })
    return Promise.resolve(onMessage(message)).catch(error => print(`! handler error: ${error.message}`))
  }

  async function send (chatId, text, { messageId } = {}) {
    const id = messageId ?? `BOT${++counter}`
    const who = chatId === SELF_CHAT_ID ? 'you (self-chat)' : chatId.replace('@console', '')
    print(`\n  ── to ${who} ──\n${text.split('\n').map(line => `  │ ${line}`).join('\n')}\n`)
    // WhatsApp echoes our own sends back as fromMe 'append' events; so do we.
    setImmediate(() => deliver({ id, chatId, fromMe: true, isSelfChat: chatId === SELF_CHAT_ID, text, timestamp: Math.floor(now() / 1000), kind: 'append' }))
    return { id }
  }

  return {
    name: 'console',
    async start () {
      print(CONSOLE_USAGE)
      rl = readline.createInterface({ input, output, terminal: false })
      rl.on('line', line => {
        const parsed = parseConsoleLine(line)
        if (!parsed) return
        if (parsed.command === 'quit') { process.kill(process.pid, 'SIGINT'); return }
        if (parsed.command === 'help' || parsed.command === 'unparsed') { print(CONSOLE_USAGE); return }
        deliver({ ...parsed, id: `IN${++counter}`, timestamp: Math.floor(now() / 1000), kind: 'notify' })
      })
      rl.on('close', () => onEnd?.()) // piped input ran out (e.g. a scripted demo)
    },
    async stop () { rl?.close() },
    send,
    sendToSelf: (text, options) => send(SELF_CHAT_ID, text, options),
    async markRead (messages) { print(`  (marked ${messages.length} message(s) read)`) },
    getHistory: (chatId, limit) => (history.get(chatId) ?? []).slice(-limit),
    generateId: () => `BOT${++counter}`
  }
}
