// Shared test fixtures: config, temp dirs, a fake transport and a scriptable fake brain. No network anywhere.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deepMerge, ROOT_DIR } from '../src/config.js'
import { parseKnowledge } from '../src/knowledge.js'

export const knowledge = parseKnowledge(readFileSync(path.join(ROOT_DIR, 'knowledge.md'), 'utf8'))

export function tempDir (t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wa-assistant-test-'))
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function makeConfig (overrides = {}, dataDir = '/nonexistent') {
  const base = JSON.parse(readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8'))
  const config = deepMerge(base, overrides)
  config.paths = { auth: path.join(dataDir, 'auth'), data: dataDir, prompts: path.join(ROOT_DIR, 'prompts'), knowledge: path.join(ROOT_DIR, 'knowledge.md') }
  return config
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const okRateLimit = { status: 'allowed', fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }

export const triageResult = (triage, extra = {}) => ({
  ok: true,
  triage: { reply: '', facts_used: [], reason: 'test', summary: 'test', ...triage },
  rateLimit: okRateLimit,
  meta: {},
  ...extra
})

export const ANSWER_HOURS = { decision: 'answer', reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', facts_used: ['F1'] }

/** Brain whose answer is chosen by `respond(input)`; `gate` lets a test hold a triage in flight. */
export function createFakeBrain (respond = () => triageResult(ANSWER_HOURS)) {
  const calls = []
  let gate = null
  return {
    name: 'test-brain',
    calls,
    hold () {
      let release
      gate = new Promise(resolve => { release = resolve })
      return () => { gate = null; release() }
    },
    async triage (input) {
      calls.push(input)
      if (gate) await gate
      return respond(input)
    }
  }
}

export function createFakeTransport () {
  const sent = []
  const read = []
  const history = new Map()
  let counter = 0
  return {
    name: 'fake',
    sent,
    read,
    history,
    down: false, // true: every send fails like a socket that is reconnecting
    sendDelayMs: 0,
    toCustomer: () => sent.filter(item => item.chatId !== 'self'),
    toSelf: () => sent.filter(item => item.chatId === 'self').map(item => item.text),
    /** Like the Baileys adapter, every message of a customer chat, ours included, lands in that chat's history. */
    remember ({ id, chatId, fromMe, text, attachment, timestamp }) {
      if (chatId === 'self') return
      history.set(chatId, [...(history.get(chatId) ?? []), { id, fromMe, text, attachment, timestamp }])
    },
    async send (chatId, text, options = {}) {
      if (this.sendDelayMs) await new Promise(resolve => setTimeout(resolve, this.sendDelayMs))
      if (this.down) throw new Error('whatsapp not connected')
      const id = options.messageId ?? `SENT${++counter}`
      sent.push({ chatId, text, id, quotedRaw: options.quotedRaw })
      this.remember({ id, chatId, fromMe: true, text, timestamp: Math.floor(Date.now() / 1000) })
      return { id }
    },
    async sendToSelf (text, options = {}) {
      return this.send('self', text, options)
    },
    async markRead (messages) { read.push(...messages.map(message => message.id)) },
    getHistory (chatId, limit) { return (history.get(chatId) ?? []).slice(-limit) },
    generateId: () => `BOT${++counter}`
  }
}

let messageCounter = 0
export function incoming (chatId, text, extra = {}) {
  return {
    id: `M${++messageCounter}`,
    chatId,
    fromMe: false,
    isSelfChat: false,
    senderName: chatId.split('@')[0],
    text,
    timestamp: Math.floor(Date.now() / 1000),
    kind: 'notify',
    ...extra
  }
}
