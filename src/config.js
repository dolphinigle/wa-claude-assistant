import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChatEntry, phoneEntry } from './chat-lists.js'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Objects merge key by key; arrays and scalars in `override` replace the base value.
export function deepMerge (base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) merged[key] = deepMerge(base[key], value)
  return merged
}

function readJson (file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
}

// Keys that no longer do anything. A stricter value set in config.local.json must not be dropped without a word, so
// the start is refused until the owner removes it.
const REMOVED_KEYS = [
  ['autoSend.minConfidence', 'the confidence gate was removed with the answer/escalate decision; see "Safety defaults" in the README for the gates that apply'],
  // Owner decision (2026-09-28): no fixed customer-facing texts. The same automated text to many chats looks like bulk
  // messaging (docs/research.md), so a leftover text must not look as if it were still sent.
  ['placeholder.text', 'the placeholder is now Claude\'s holding reply, written for each sender and checked by the guards; see "Escalation placeholder" in the README'],
  ['greetingReply.text', 'the greeting-back is now Claude\'s own reply to each sender, sent only if it just asks; see "Greeting-back" in the README']
]

const CLOUD_API_REQUIRED = ['phoneNumberId', 'accessToken', 'appSecret', 'verifyToken', 'ownerNumber']

// The Cloud API's secrets live only in config.local.json; errors name the keys, never their values.
function checkTransport (config) {
  if (!['baileys', 'cloud-api'].includes(config.transport)) throw new Error(`config.transport must be "baileys" or "cloud-api", got ${JSON.stringify(config.transport)}`)
  if (config.transport !== 'cloud-api') return
  const cloud = isPlainObject(config.cloudApi) ? config.cloudApi : {}
  const present = value => (typeof value === 'string' ? value.trim() !== '' : typeof value === 'number')
  const missing = CLOUD_API_REQUIRED.filter(key => !present(cloud[key]))
  if (missing.length > 0) throw new Error(`transport "cloud-api" needs ${missing.map(key => `cloudApi.${key}`).join(', ')} in config.local.json (see "Official WhatsApp Cloud API" in the README)`)
  if (!/^\d+$/.test(String(cloud.phoneNumberId).trim())) throw new Error('config.cloudApi.phoneNumberId must be the numeric Phone number ID from the Meta app\'s API Setup page')
  if (!phoneEntry(cloud.ownerNumber)) throw new Error('config.cloudApi.ownerNumber must be your personal WhatsApp number (e.g. "0812…", "62812…" or "+62 812…")')
  if (!(Number.isInteger(cloud.port) && cloud.port > 0 && cloud.port < 65536)) throw new Error(`config.cloudApi.port must be a port number, got ${JSON.stringify(cloud.port)}`)
  if (typeof cloud.webhookPath !== 'string' || !cloud.webhookPath.startsWith('/')) throw new Error(`config.cloudApi.webhookPath must start with "/", got ${JSON.stringify(cloud.webhookPath)}`)
  if (!/^v\d+\.\d+$/.test(cloud.graphVersion ?? '')) throw new Error(`config.cloudApi.graphVersion must look like "v26.0", got ${JSON.stringify(cloud.graphVersion)}`)
  config.cloudApi = { ...cloud, phoneNumberId: String(cloud.phoneNumberId).trim() }
}

/**
 * config.json (committed defaults) deep-merged with config.local.json (gitignored), then `overrides`.
 * Relative paths are resolved against `rootDir`.
 */
export function loadConfig ({ rootDir = ROOT_DIR, overrides = {} } = {}) {
  const base = readJson(path.join(rootDir, 'config.json'))
  const localFile = path.join(rootDir, 'config.local.json')
  const local = existsSync(localFile) ? readJson(localFile) : {}
  const config = deepMerge(deepMerge(base, local), overrides)

  if (!['shadow', 'live'].includes(config.mode)) throw new Error(`config.mode must be "shadow" or "live", got ${JSON.stringify(config.mode)}`)
  // A malformed list must not quietly widen or empty what the assistant handles, or block nothing (a pushName) or
  // everything (a string blocklist throws on every message).
  for (const key of ['allowChats', 'blocklist']) {
    if (config[key] === undefined) config[key] = []
    if (!Array.isArray(config[key]) || !config[key].every(isChatEntry)) {
      throw new Error(`config.${key} must be a list of JIDs or phone numbers (e.g. ["081234567890"]; a JID as WhatsApp writes it: "6281234567890@s.whatsapp.net" or "123456789012345@lid"), got ${JSON.stringify(config[key])}`)
    }
  }
  for (const [key, why] of REMOVED_KEYS) {
    if (key.split('.').reduce((node, part) => node?.[part], config) !== undefined) throw new Error(`config ${key} is no longer supported (${why}); remove it from config.local.json`)
  }
  // Switches only: their texts are Claude's, written per sender (owner decision 2026-09-28).
  for (const key of ['placeholder', 'greetingReply']) {
    const section = config[key]
    if (!isPlainObject(section) || typeof section.enabled !== 'boolean') throw new Error(`config.${key} must be {"enabled": true or false}, got ${JSON.stringify(section)}`)
  }
  // How often one chat may get a holding reply (owner request 2026-09-30): a quoted or negative value would lift the limit.
  const repeat = config.placeholder.repeatMinutes
  if (repeat !== undefined && !(typeof repeat === 'number' && Number.isFinite(repeat) && repeat >= 0)) throw new Error(`config.placeholder.repeatMinutes must be a number >= 0 (minutes between two holding replies to one chat), got ${JSON.stringify(repeat)}`)
  // The switches for what reaches customers on its own are read as truthy: a quoted "false" would leave them on, and
  // `autoSend.enabled` false is the owner's "drafts only" switch (correctness-r1-4).
  for (const key of ['autoSend.enabled', 'backlog.autoSend']) {
    const value = key.split('.').reduce((node, part) => node?.[part], config)
    if (typeof value !== 'boolean') throw new Error(`config.${key} must be true or false (no quotes), got ${JSON.stringify(value)}`)
  }
  // Demo mode invents answers (owner decision 2026-09-27), so it must never reach a real customer by accident: an exact
  // boolean, and only with the testers listed. Its per-chat cap must be a number: anything else would lift the cap.
  const demo = config.demo
  if (!isPlainObject(demo) || typeof demo.enabled !== 'boolean') throw new Error(`config.demo.enabled must be true or false (no quotes), got ${JSON.stringify(demo?.enabled ?? demo)}`)
  if (demo.enabled && config.allowChats.length === 0) throw new Error('demo mode invents answers: list the testers in allowChats (config.demo.enabled is true, allowChats is empty)')
  if (demo.enabled && !(Number.isInteger(demo.maxPerChatPerHour) && demo.maxPerChatPerHour >= 0)) throw new Error(`config.demo.maxPerChatPerHour must be a whole number >= 0, got ${JSON.stringify(demo.maxPerChatPerHour)}`)
  if (demo.enabled && demo.maxReplyChars !== undefined && !(Number.isInteger(demo.maxReplyChars) && demo.maxReplyChars > 0)) throw new Error(`config.demo.maxReplyChars must be a whole number > 0, got ${JSON.stringify(demo.maxReplyChars)}`)
  // The Borma demo reads real shop data and looks up the sender's orders: on only when the owner says so, exactly.
  const borma = config.borma
  if (borma !== undefined && (!isPlainObject(borma) || typeof borma.enabled !== 'boolean')) throw new Error(`config.borma.enabled must be true or false (no quotes), got ${JSON.stringify(borma?.enabled ?? borma)}`)
  // The order lookup is on unless it is exactly false (lookup.js), so a quoted "false" would leave it on.
  if (borma?.orders !== undefined && typeof borma.orders !== 'boolean') throw new Error(`config.borma.orders must be true or false (no quotes), got ${JSON.stringify(borma.orders)}`)
  if (borma?.refreshHours !== undefined && !(typeof borma.refreshHours === 'number' && Number.isFinite(borma.refreshHours) && borma.refreshHours >= 0)) throw new Error(`config.borma.refreshHours must be a number >= 0 (0 = never refresh the export), got ${JSON.stringify(borma.refreshHours)}`)
  // The conversation window Claude sees (owner request 2026-09-29): a quoted or negative value would silently show all.
  for (const key of ['contextMessages', 'contextMaxAgeMinutes']) {
    if (!(Number.isInteger(config[key]) && config[key] >= 0)) throw new Error(`config.${key} must be a whole number >= 0 (0 = ${key === 'contextMessages' ? 'no earlier messages' : 'no age limit'}), got ${JSON.stringify(config[key])}`)
  }
  checkTransport(config)
  config.rootDir = rootDir
  config.paths = {
    auth: path.resolve(rootDir, config.paths.auth),
    data: path.resolve(rootDir, config.paths.data),
    prompts: path.resolve(rootDir, config.paths.prompts ?? 'prompts'),
    knowledge: path.resolve(rootDir, config.knowledgeFile ?? 'knowledge.md')
  }
  return config
}
