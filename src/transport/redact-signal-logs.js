// libsignal (Baileys' Signal protocol code) prints whole session records with console.info/warn ("Closing session:",
// session), private ratchet and root keys included, whatever BAILEYS_LOG_LEVEL says. stdout ends up in terminals and
// log files, so a record is replaced before any console method sees it. Seen live on 2026-09-27 on the first start.

const REDACTED = '[signal session redacted]'
const INSTALLED = Symbol.for('wa-claude-assistant.redactSignalSessions')

/** A libsignal SessionEntry, or anything shaped like one: it carries ratchet state. */
const isSessionRecord = value => value !== null && typeof value === 'object' &&
  ('currentRatchet' in value || '_chains' in value || 'indexInfo' in value)

export function redactSignalSessions (target = console) {
  if (target[INSTALLED]) return
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
    if (typeof target[method] !== 'function') continue
    const original = target[method].bind(target)
    target[method] = (...args) => original(...args.map(arg => (isSessionRecord(arg) ? REDACTED : arg)))
  }
  Object.defineProperty(target, INSTALLED, { value: true })
}
