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

    default: {
      return undefined
    }
  }
}

export function humanSink(write: (text: string) => void = (text) => process.stderr.write(text)) {
  return (event: ReportEvent): void => {
    const line = formatHuman(event)
    if (line !== undefined) write(`${line}\n`)
  }
}
