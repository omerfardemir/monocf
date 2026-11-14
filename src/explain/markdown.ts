import {CHECK_RULES, ERROR_CODES, exitCodeText, PLAN_REASONS, type CheckRuleExplanation, type Explanation} from './registry.js'

function cell(text: string | undefined): string {
  return (text ?? '').replaceAll('|', String.raw`\|`)
}

interface Column {
  head: string
  value(code: string): string
}

function table(head: string, rows: [string, Explanation][], extra: Column[] = []): string {
  const heads = [head, ...extra.map((column) => column.head), 'Meaning', 'What to do']
  const header = `| ${heads.join(' | ')} |\n|${heads.map(() => '---').join('|')}|\n`
  return `${header}${rows
    .map(([code, {meaning, next}]) => `| ${[`\`${code}\``, ...extra.map((column) => column.value(code)), cell(meaning), cell(next)].join(' | ')} |`)
    .join('\n')}\n`
}

const exitColumn: Column = {head: 'Exit', value: (code) => exitCodeText(ERROR_CODES[code as keyof typeof ERROR_CODES].exitCode)}
const levelColumn: Column = {head: 'Level', value: (code) => (CHECK_RULES[code as keyof typeof CHECK_RULES] as CheckRuleExplanation).levels.join(' or ')}

/** The tables docs/json-output.md holds between its `codes` markers. */
export function formatCodesMarkdown(): string {
  return [
    `### Error codes\n\n${table('Code', Object.entries(ERROR_CODES), [exitColumn])}`,
    `### Check rules\n\n${table('Rule', Object.entries(CHECK_RULES), [levelColumn])}`,
    `### Plan reasons\n\n${table('Reason', Object.entries(PLAN_REASONS))}`,
  ].join('\n')
}

/** The README's tables of codes, by the name of their markers: the README is where a person reads them, and explain where an agent does. */
export function formatReadmeTables(): Record<string, string> {
  const ignoreRules = Object.entries(CHECK_RULES).filter(([rule]) => rule.startsWith('ignored-'))
  return {
    'ignore-rules': table('Rule', ignoreRules, [levelColumn]),
    'plan-reasons': table('Reason', Object.entries(PLAN_REASONS)),
  }
}

/** Puts each generated table between `<!-- name -->` and `<!-- namestop -->`, as oclif marks the command reference. */
export function replaceMarked(text: string, tables: Record<string, string>): string {
  let updated = text
  for (const [name, content] of Object.entries(tables)) {
    const marked = new RegExp(String.raw`<!-- ${name} -->[\s\S]*<!-- ${name}stop -->`)
    if (!marked.test(updated)) throw new Error(`No <!-- ${name} --> markers.`)
    updated = updated.replace(marked, () => `<!-- ${name} -->\n${content}<!-- ${name}stop -->`)
  }

  return updated
}
