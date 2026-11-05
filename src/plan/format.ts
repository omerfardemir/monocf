import type {Plan, PlanAction, PlanNote, PlanStep} from './plan.js'

const ACTIONS: PlanAction[] = ['create', 'full-deploy', 'upload', 'triggers', 'adopt', 'skip', 'blocked']
const WARNINGS = new Set<PlanNote['kind']>(['baseline', 'drift'])

function isDeploy({action}: PlanStep): boolean {
  return action !== 'skip' && action !== 'adopt' && action !== 'blocked'
}

function actionCounts({steps}: Plan): [PlanAction, number][] {
  return ACTIONS.map((action): [PlanAction, number] => [action, steps.filter((step) => step.action === action).length]).filter(
    ([, count]) => count > 0,
  )
}

/** What a smoke test has to look at beyond the deployed workers themselves. */
function callersToCheck({steps}: Plan): string[] {
  const deployed = steps.filter((step) => isDeploy(step))
  const names = new Set(deployed.flatMap(({transitiveCallers}) => transitiveCallers))
  for (const {worker} of deployed) names.delete(worker)
  return [...names].sort()
}

/** The deploying steps grouped so each group only waits for earlier groups. For people: `apply` reads `dependsOn`. */
export function deployLevels(plan: Plan): string[][] {
  const levels: string[][] = []
  const placed = new Set<string>()
  let remaining = plan.steps.filter((step) => isDeploy(step))
  while (remaining.length > 0) {
    const ready = remaining.filter(({dependsOn}) => dependsOn.every((name) => placed.has(name)))
    // Blocked steps aren't placed. What depends on one goes in a last group, as `apply` won't run the plan anyway.
    const level = ready.length > 0 ? ready : remaining
    levels.push(level.map(({worker}) => worker).sort())
    for (const {worker} of level) placed.add(worker)
    remaining = remaining.filter(({worker}) => !placed.has(worker))
  }

  return levels
}

function countLine(plan: Plan): string {
  return actionCounts(plan)
    .map(([action, count]) => `${count} ${action}`)
    .join(', ')
}

function noteLine({deployedName, kind, message, worker}: PlanNote): string {
  return `${kind}: ${worker}${deployedName ? ` (${deployedName})` : ''}: ${message}`
}

/** The human summary, for stderr. */
export function formatSummary(plan: Plan): string {
  const lines = [`Plan for ${plan.env} at ${plan.commit}: ${countLine(plan) || 'no workers'}.`]
  if (plan.accounts?.length) lines.push(`Account: ${plan.accounts.join(', ')}.`)
  for (const step of plan.steps) {
    if (step.action !== 'skip') lines.push(`  ${step.worker}: ${step.action} (${step.reasons.join(', ')})`)
  }

  const levels = deployLevels(plan)
  if (levels.length > 0) lines.push('Order:', ...levels.map((level, index) => `  ${index + 1}. ${level.join(', ')}`))
  const callers = callersToCheck(plan)
  if (callers.length > 0) lines.push(`Callers to check: ${callers.join(', ')}`)
  lines.push(...plan.notes.map((note) => `${WARNINGS.has(note.kind) ? 'warning' : 'note'} ${noteLine(note)}`))
  if (plan.refused !== undefined) lines.push(`Refused: ${plan.refused}`)
  else if (!plan.applicable) lines.push('Blocked: this plan can\'t be applied. Look at the drift above, then plan again.')
  return `${lines.join('\n')}\n`
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`)
}

/** A compact summary for a PR comment. Names only: no secrets, no values, no IDs. */
export function formatMarkdown(plan: Plan): string {
  const account = plan.accounts?.length ? ` Account: ${plan.accounts.join(', ')}.` : ''
  const lines = [`## monocf plan: ${plan.env}`, '', `Commit \`${plan.commit}\`, wrangler ${plan.wrangler}.${account}`, '']
  if (plan.refused !== undefined) lines.push(`**Refused:** ${plan.refused}`, '')
  else if (!plan.applicable) lines.push('**Blocked: this plan can\'t be applied.** Look at the drift below, then plan again.', '')

  lines.push('| Action | Workers |', '|---|---|', ...actionCounts(plan).map(([action, count]) => `| ${action} | ${count} |`), '')

  // Blocked stays in the table: a person has to look at it, and it would otherwise deploy.
  const changed = plan.steps.filter((step) => step.action !== 'skip' && step.action !== 'adopt')
  if (changed.length > 0) {
    lines.push(
      '### Workers to deploy',
      '',
      '| Worker | Action | Reasons |',
      '|---|---|---|',
      ...changed.map(({action, reasons, worker}) => `| ${cell(worker)} | ${action} | ${reasons.join(', ')} |`),
      '',
    )
  }

  const callers = callersToCheck(plan)
  if (callers.length > 0) lines.push('### Callers to check', '', callers.map((name) => `\`${name}\``).join(', '), '')

  const warnings = plan.notes.filter(({kind}) => WARNINGS.has(kind))
  if (warnings.length > 0) lines.push('### Drift warnings', '', ...warnings.map((note) => `- ${noteLine(note)}`), '')

  const others = plan.notes.filter(({kind}) => !WARNINGS.has(kind))
  if (others.length > 0) lines.push('### Notes', '', ...others.map((note) => `- ${noteLine(note)}`), '')

  return `${lines.join('\n').trimEnd()}\n`
}
