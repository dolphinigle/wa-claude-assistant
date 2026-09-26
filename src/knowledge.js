import { readFileSync } from 'node:fs'

const FACT_LINE = /^\s*[-*]?\s*\[(F\d+)\]\s*(.+)$/

function section (markdown, heading) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
}

/**
 * Parses knowledge.md. `promptText` is what Claude sees (HTML comments stripped); `factsText` and `facts` are
 * the only ground truth the guards accept for auto-sent replies.
 */
export function parseKnowledge (markdown) {
  const promptText = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
  const factsText = section(promptText, 'Facts')
  const facts = new Map()
  for (const line of factsText.split('\n')) {
    const match = line.match(FACT_LINE)
    if (match) facts.set(match[1], match[2].trim())
  }
  return { promptText, factsText, facts }
}

export function loadKnowledge (file) {
  const knowledge = parseKnowledge(readFileSync(file, 'utf8'))
  if (knowledge.facts.size === 0) throw new Error(`${file} has no "## Facts" entries like "- [F1] ..."`)
  return knowledge
}
