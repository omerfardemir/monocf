import type {RecordResult, RunRecord} from '../state/run-record.js'

const RESULTS: RecordResult[] = ['ok', 'failed', 'refused', 'skipped', 'cancelled', 'unchanged']

interface Row {
  action: string
  note: string
  result: string
  version: string
  worker: string
}

function rowsOf({workers}: RunRecord): Row[] {
  return Object.entries(workers).map(([worker, {action, message, newVersionId, reason, result}]) => ({
    action,
    note: message ?? (reason ? `because ${reason} failed` : ''),
    result,
    version: newVersionId ?? '',
    worker,
  }))
}

function countLine({workers}: RunRecord): string {
  const results = Object.values(workers).map(({result}) => result)
  return RESULTS.map((name) => [name, results.filter((result) => result === name).length] as const)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
}

/** Uploaded and not promoted. The next version inherits secrets from the latest upload, so these are worth a name. */
export function unpromotedUploads({workers}: RunRecord): string[] {
  return Object.entries(workers)
    .filter(([, {newVersionId, uploadedVersionId}]) => uploadedVersionId !== undefined && newVersionId === undefined)
    .map(([worker]) => worker)
}

function pad(text: string, width: number): string {
  return text.padEnd(width)
}

export function formatRunSummary(record: RunRecord, problems: string[] = []): string {
  const rows = rowsOf(record)
  const widths = (['worker', 'action', 'result'] as const).map((key) => Math.max(key.length, ...rows.map((row) => row[key].length)))
  const line = (row: Omit<Row, 'note' | 'version'> & {tail: string}) =>
    `  ${pad(row.worker, widths[0])}  ${pad(row.action, widths[1])}  ${pad(row.result, widths[2])}  ${row.tail}`.trimEnd()
  const lines = [
    `Run ${record.runId} on ${record.env}: ${countLine(record) || 'no workers'}.`,
    ...(rows.length > 0 ? [line({action: 'action', result: 'result', tail: 'version or note', worker: 'worker'})] : []),
    ...rows.map(({action, note, result, version, worker}) => line({action, result, tail: [version, note].filter(Boolean).join(' '), worker})),
  ]
  const unpromoted = unpromotedUploads(record)
  if (unpromoted.length > 0) lines.push(`Uploaded and not promoted: ${unpromoted.join(', ')}. The next version of each inherits from that upload.`)
  lines.push(...problems)
  return `${lines.join('\n')}\n`
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll(/\s*\r?\n\s*/g, ' ')
}

/** For `$GITHUB_STEP_SUMMARY`. */
export function formatRunMarkdown(record: RunRecord, problems: string[] = []): string {
  const lines = [
    `## monocf ${record.kind}: ${record.env}`,
    '',
    `Run \`${record.runId}\`, commit \`${record.commit}\`: ${countLine(record) || 'no workers'}.`,
    '',
    '| Worker | Action | Result | Version | Note |',
    '|---|---|---|---|---|',
    ...rowsOf(record).map(({action, note, result, version, worker}) => `| ${cell(worker)} | ${action} | ${result} | ${version} | ${cell(note)} |`),
    '',
  ]
  const unpromoted = unpromotedUploads(record)
  if (unpromoted.length > 0) lines.push(`**Uploaded and not promoted:** ${unpromoted.join(', ')}. The next version of each inherits from that upload.`, '')
  if (problems.length > 0) lines.push(...problems.map((problem) => `**${cell(problem)}**`), '')
  return `${lines.join('\n').trimEnd()}\n`
}
