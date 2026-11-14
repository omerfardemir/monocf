import {CHECK_RULES, ERROR_CODES, PLAN_REASONS, type ExitCodeOf, type Explanation} from './registry.js'

function cell(text: string | undefined): string {
  return (text ?? '').replaceAll('|', String.raw`\|`)
}

function exitCell(exitCode: ExitCodeOf): string {
  return exitCode === 'signal' ? '128 + n' : String(exitCode)
}

function table(head: string, rows: [string, Explanation][], exit?: (code: string) => string): string {
  const header = exit ? `| ${head} | Exit | Meaning | What to do |\n|---|---|---|---|\n` : `| ${head} | Meaning | What to do |\n|---|---|---|\n`
  return `${header}${rows
    .map(([code, {meaning, next}]) => `| \`${code}\` |${exit ? ` ${exit(code)} |` : ''} ${cell(meaning)} | ${cell(next)} |`)
    .join('\n')}\n`
}

/** The tables docs/json-output.md holds between its `codes` markers. `npm run docs` writes them, and a test checks they match. */
export function formatCodesMarkdown(): string {
  const errors = table('Code', Object.entries(ERROR_CODES), (code) => exitCell(ERROR_CODES[code as keyof typeof ERROR_CODES].exitCode))
  return [
    `### Error codes\n\n${errors}`,
    `### Check rules\n\n${table('Rule', Object.entries(CHECK_RULES))}`,
    `### Plan reasons\n\n${table('Reason', Object.entries(PLAN_REASONS))}`,
  ].join('\n')
}
