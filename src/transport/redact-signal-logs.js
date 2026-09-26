// libsignal (Baileys' Signal protocol code) prints whole session records with console.info/warn ("Closing session:",
// session), private ratchet and root keys included, whatever BAILEYS_LOG_LEVEL says. stdout ends up in terminals and
// log files, so a record is replaced before any console method sees it. Seen live on 2026-09-27 on the first start.

const REDACTED = '[signal session redacted]'
const INSTALLED = Symbol.for('wa-claude-assistant.redactSignalSessions')

const SECRET_KEYS = ['currentRatchet', '_chains', 'indexInfo', 'sessions', '_sessions', 'privKey', 'rootKey', 'chainKey']
const MAX_DEPTH = 4

/**
 * A libsignal SessionEntry or SessionRecord, or anything holding one or a private key a few levels down: today's
 * libsignal passes records at the top level only, but a version bump could nest them.
 */
const holdsSignalSecrets = (value, depth = 0) => {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return false
  if (SECRET_KEYS.some(key => key in value)) return true
  if (depth >= MAX_DEPTH) return false
  return Object.values(value).some(item => holdsSignalSecrets(item, depth + 1))
}

export function redactSignalSessions (target = console) {
  if (target[INSTALLED]) return
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
    if (typeof target[method] !== 'function') continue
    const original = target[method].bind(target)
    target[method] = (...args) => original(...args.map(arg => {
      try { return holdsSignalSecrets(arg) ? REDACTED : arg } catch { return REDACTED } // a throwing getter: fail closed
    }))
  }
  Object.defineProperty(target, INSTALLED, { value: true })
}
