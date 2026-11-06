import type {ReportEvent} from './events.js'

/** Progress for people. A failure is left out, because the error it raises is printed once, on one line. */
export function formatHuman(event: ReportEvent): string | undefined {
  switch (event.type) {
    case 'notice': {
      return `notice: ${event.message}`
    }

    case 'finding': {
      return `${event.level} ${event.rule}: ${event.message}`
    }

    case 'step-started': {
      return `${event.worker}: ${event.action}`
    }

    case 'step-finished': {
      if (event.status === 'skipped') return `${event.worker}: ${event.action} skipped, because ${event.reason} failed`
      if (event.status === 'cancelled') return `${event.worker}: ${event.action} cancelled`
      if (event.status !== 'ok') return undefined
      return `${event.worker}: ${event.action} done${event.versionId ? `, version ${event.versionId}` : ''}`
    }

    case 'secrets-check': {
      const parts = [
        ...(event.missing?.length ? [`missing ${event.missing.join(', ')}`] : []),
        ...(event.extra?.length ? [`warning: not expected ${event.extra.join(', ')}`] : []),
        ...(event.present?.length ? [`has ${event.present.join(', ')}`] : []),
        ...(event.note ? [event.note] : []),
      ]
      return `${event.worker}: ${parts.join('; ') || 'nothing expected'}`
    }

    default: {
      return undefined
    }
  }
}

/** A command's result goes to stdout, so that a script can read it. Progress and notices go to stderr. */
export function humanSink(
  write: (text: string) => void = (text) => process.stderr.write(text),
  result: (text: string) => void = (text) => process.stdout.write(text),
) {
  return (event: ReportEvent): void => {
    const line = formatHuman(event)
    if (line !== undefined) (event.type === 'secrets-check' ? result : write)(`${line}\n`)
  }
}
