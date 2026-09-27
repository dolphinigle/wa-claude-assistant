import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChatEntry } from './chat-lists.js'

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
  ['autoSend.minConfidence', 'the confidence gate was removed with the answer/escalate decision; see "Safety defaults" in the README for the gates that apply']
]

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
  // Sent to customers as they are: a typo must stop the start, not reach them, and a missing text must not go out empty.
  for (const key of ['placeholder', 'greetingReply']) {
    const section = config[key]
    if (!isPlainObject(section) || typeof section.enabled !== 'boolean' || !isPlainObject(section.text) ||
      !['id', 'en'].every(language => typeof section.text[language] === 'string' && section.text[language].trim())) {
      throw new Error(`config.${key} must be {"enabled": true or false, "text": {"id": "…", "en": "…"}} with both texts set, got ${JSON.stringify(section)}`)
    }
  }
  // The switches for what reaches customers on its own are read as truthy: a quoted "false" would leave them on, and
  // `autoSend.enabled` false is the owner's "drafts only" switch (correctness-r1-4).
  for (const key of ['autoSend.enabled', 'backlog.autoSend']) {
    const value = key.split('.').reduce((node, part) => node?.[part], config)
    if (typeof value !== 'boolean') throw new Error(`config.${key} must be true or false (no quotes), got ${JSON.stringify(value)}`)
  }
  for (const [key, why] of REMOVED_KEYS) {
    if (key.split('.').reduce((node, part) => node?.[part], config) !== undefined) throw new Error(`config ${key} is no longer supported (${why}); remove it from config.local.json`)
  }
  config.rootDir = rootDir
  config.paths = {
    auth: path.resolve(rootDir, config.paths.auth),
    data: path.resolve(rootDir, config.paths.data),
    prompts: path.resolve(rootDir, config.paths.prompts ?? 'prompts'),
    knowledge: path.resolve(rootDir, config.knowledgeFile ?? 'knowledge.md')
  }
  return config
}
