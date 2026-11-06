import {SCHEMA_VERSION, type ReportEvent} from './events.js'

export function formatNdjson(event: object): string {
  return `${JSON.stringify({schemaVersion: SCHEMA_VERSION, ...event})}\n`
}

export function ndjsonSink(write: (text: string) => void = (text) => process.stdout.write(text)) {
  return (event: ReportEvent): void => {
    write(formatNdjson(event))
  }
}
