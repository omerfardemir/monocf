import {MonocfError} from '../errors.js'
import {allEntries, explain, type ExplainEntry} from '../explain/registry.js'
import {SCHEMA_VERSION} from '../report/events.js'

const KIND_NAMES = {'check-rule': 'check rule', error: 'error code', 'plan-reason': 'plan reason'} as const

function exitOf({exitCode}: ExplainEntry): string {
  if (exitCode === undefined) return ''
  return exitCode === 'signal' ? ', exit 128 + the signal' : `, exit ${exitCode}`
}

function formatEntry(entry: ExplainEntry): string {
  return `${entry.code} (${KIND_NAMES[entry.kind]}${exitOf(entry)})\n  ${entry.meaning}\n${entry.next ? `  Next: ${entry.next}\n` : ''}`
}

/** `monocf explain`: with no code, every code there is. A code can be more than one kind, as `drift` is. */
export function runExplain(code: string | undefined, {json = false}: {json?: boolean} = {}): void {
  const entries = code === undefined ? allEntries() : explain(code)
  if (entries.length === 0) throw new MonocfError(`Unknown code: ${code}.`, {code: 'unknown-code'})
  if (json) {
    process.stdout.write(`${JSON.stringify({entries, schemaVersion: SCHEMA_VERSION}, null, 2)}\n`)
  } else if (code === undefined) {
    process.stdout.write(entries.map(({code, kind, meaning}) => `${KIND_NAMES[kind]}  ${code}: ${meaning}\n`).join(''))
  } else {
    process.stdout.write(entries.map((entry) => formatEntry(entry)).join('\n'))
  }
}
