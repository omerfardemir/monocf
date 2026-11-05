import type {ManifestWorker} from '../app/bundle.js'
import type {Triggers} from '../fingerprint/fingerprint.js'
import type {Graph} from '../graph/graph.js'
import {callers, computeOrder, directCallers, nearestWithin} from '../graph/order.js'
import type {StateManifest, StateWorker} from '../state/manifest.js'
import type {ActiveInfo} from '../wrangler/read.js'

export const PLAN_SCHEMA_VERSION = 1

export type PlanAction = 'adopt' | 'blocked' | 'create' | 'full-deploy' | 'skip' | 'triggers' | 'upload'

export type PlanReason =
  | 'baseline'
  | 'bundle-changed'
  | 'config-changed'
  | 'do-changed'
  | 'drift'
  | 'external-changed'
  | 'needs-deploy'
  | 'new'
  | 'provider-recreated'
  | 'secret-changed'
  | 'split'
  | 'state-behind'
  | 'state-missing'
  | 'triggers-changed'
  | 'unchanged'

export type OnDrift = 'fail' | 'warn'

export interface PlanStep {
  action: PlanAction
  bundleHash: string
  callers: string[]
  configHash: string
  dependsOn: string[]
  deployedName: string
  doHash: string
  /** `apply` writes `"crons": []` for this step: with the key absent, wrangler would leave the removed crons running. */
  explicitEmptyCrons: boolean
  externalHash: string
  fingerprint: string
  /** For a `create` of a worker the manifest knows: the callers `apply` marks in the manifest before this runs. */
  markCallers?: string[]
  /** The version Cloudflare serves now, or the largest share of a split rollout. Absent when the worker doesn't exist. */
  previousVersionId?: string
  reasons: PlanReason[]
  /** A crashed run left this version live, so `apply` records it, and applies the triggers that run may not have reached. */
  recordState?: true
  transitiveCallers: string[]
  triggers: Triggers
  /** The triggers need applying: they changed, or nothing says what is live. */
  triggersChanged: boolean
  triggersHash: string
  version?: string
  worker: string
}

export type PlanNoteKind =
  | 'baseline'
  | 'caller-ignored'
  | 'caller-not-selected'
  | 'drift'
  | 'orphan'
  | 'recreated'
  | 'renamed'
  | 'routes-removed'
  | 'secret-changed'
  | 'state-behind'

export interface PlanNote {
  deployedName?: string
  kind: PlanNoteKind
  message: string
  worker: string
}

export interface Plan {
  /** The masks of the accounts this plan looked at, or what chose them. No ID. */
  accounts?: string[]
  /** False when any step is blocked or the plan is refused, so `apply` refuses it too. */
  applicable: boolean
  /** The real HEAD of the checkout. CI's variables can name another commit. */
  commit: string
  createdAt: string
  env: string
  notes: PlanNote[]
  /** What the plan wrote or read beside the code, relative to the root. `apply` doesn't take these for changes to the checkout. */
  outputs?: string[]
  /** Why this looks like the wrong account or state rather than a real plan, and which flag accepts it. Exit 3. */
  refused?: string
  schemaVersion: number
  state: string
  steps: PlanStep[]
  wrangler: string
}

/** The part of a bundle manifest a plan reads. */
export interface PlanBundle {
  commit: string
  env: string
  workers: Record<string, ManifestWorker>
  wrangler: string
}

/** What tells a wrong account from a first run. Without these, a plan has no opinion on it. */
export interface PlanGuards {
  /** By worker, where the account is known. */
  accountHashes: Record<string, string | undefined>
  accounts: string[]
  allowRecreate: boolean
  firstRun: boolean
}

export interface PlanOptions {
  createdAt: string
  guards?: PlanGuards
  onDrift: OnDrift
  /** Every worker that isn't selected through the ignore file, with its edges. A caller here is never touched, so a note names it. */
  ignored?: {graph: Graph; workers: string[]}
  /** Every worker directory in the repository, ignored ones too. A state entry for anything else is an orphan. */
  repositoryWorkers: string[]
  state: string
}

interface Decision {
  action: PlanAction
  notes: Omit<PlanNote, 'worker'>[]
  reasons: PlanReason[]
  recordState?: true
  triggersChanged: boolean
}

export function tagFor(fingerprint: string): string {
  return `monocf:${fingerprint}`
}

function isTriggersChanged(worker: ManifestWorker, entry: StateWorker): boolean {
  return worker.triggersHash !== entry.triggersHash
}

/** What a worker that is live at `entry` needs to reach this bundle. */
function compareToState(worker: ManifestWorker, entry: StateWorker): Decision {
  const triggersChanged = isTriggersChanged(worker, entry)
  if (worker.fingerprint === entry.fingerprint) return triggersOnly(worker, entry)
  if (worker.doHash !== entry.doHash) return {action: 'full-deploy', notes: [], reasons: ['do-changed'], triggersChanged}

  const reasons: PlanReason[] = [
    ...(worker.bundleHash === entry.bundleHash ? [] : (['bundle-changed'] as const)),
    ...(worker.configHash === entry.configHash ? [] : (['config-changed'] as const)),
    ...(worker.externalHash === entry.externalHash ? [] : (['external-changed'] as const)),
  ]
  return {action: 'upload', notes: [], reasons, triggersChanged}
}

/** The code is already live. Only the triggers can be behind. */
function triggersOnly(worker: ManifestWorker, entry: StateWorker): Decision {
  return isTriggersChanged(worker, entry)
    ? {action: 'triggers', notes: [], reasons: ['triggers-changed'], triggersChanged: true}
    : {action: 'skip', notes: [], reasons: ['unchanged'], triggersChanged: false}
}

function blocked(reasons: PlanReason[], notes: Decision['notes']): Decision {
  return {action: 'blocked', notes, reasons, triggersChanged: false}
}

/**
 * Something else is live. Its triggers are unknown too, since a manual `wrangler deploy` applies its own, so they are
 * applied again. A worker that is otherwise the same still needs an upload, or the other version stays live.
 */
function drifted(worker: ManifestWorker, entry: StateWorker | undefined, {message, split}: {message: string; split: boolean}, onDrift: OnDrift): Decision {
  const reasons: PlanReason[] = ['drift', ...(split ? (['split'] as const) : [])]
  const notes = [{kind: 'drift' as const, message}]
  if (onDrift === 'fail') return blocked(reasons, notes)

  const base = entry ? compareToState(worker, entry) : undefined
  if (base?.action === 'full-deploy' || base?.action === 'upload') {
    return {...base, notes, reasons: [...reasons, ...base.reasons], triggersChanged: true}
  }

  return {action: 'upload', notes, reasons, triggersChanged: true}
}

/**
 * The manifest is behind what is live, but the tag shows monocf put it there: a run that crashed before writing state. Nothing
 * says it got as far as its triggers, so they're applied whatever the manifest says about them.
 */
function stateBehind(decision: Decision): Decision {
  const message = 'The active version carries the expected tag, but the state manifest names another. A previous run likely stopped before writing state.'
  const recovered = decision.action === 'skip' ? {...decision, action: 'triggers' as const, reasons: ['state-behind' as const]} : decision
  return {...recovered, notes: [{kind: 'state-behind', message}], recordState: true, triggersChanged: true}
}

/**
 * A secret command made the active version, from an upload carrying the fingerprint the state knows. The upload that follows
 * tags known code and inherits the secret. A rotation is routine, so this isn't drift.
 */
function secretChanged(worker: ManifestWorker, entry: StateWorker): Decision {
  const base = compareToState(worker, entry)
  const reasons = base.reasons.filter((reason) => reason !== 'unchanged' && reason !== 'triggers-changed')
  const message = 'A secret command made the active version, so this commit uploads over it to tag it. The secret carries over.'
  return {
    action: base.action === 'full-deploy' ? 'full-deploy' : 'upload',
    notes: [{kind: 'secret-changed', message}],
    reasons: ['secret-changed', ...reasons],
    triggersChanged: base.triggersChanged,
  }
}

function classify(worker: ManifestWorker, entry: StateWorker | undefined, active: ActiveInfo, onDrift: OnDrift): Decision {
  if (active.state === 'missing') {
    const notes = entry ? [{kind: 'recreated' as const, message: 'The state manifest knows this worker, but it no longer exists on Cloudflare.'}] : []
    return {action: 'create', notes, reasons: ['new'], triggersChanged: true}
  }

  if (active.state === 'split') return drifted(worker, entry, {message: 'A split rollout is live.', split: true}, onDrift)

  if (!entry) {
    if (active.tag === tagFor(worker.fingerprint)) {
      return {action: 'adopt', notes: [], reasons: ['state-missing'], recordState: true, triggersChanged: true}
    }

    const message = 'The worker exists with no state entry, and its tag differs from this bundle.'
    const notes = [{kind: 'baseline' as const, message}]
    return onDrift === 'fail'
      ? blocked(['drift', 'baseline'], notes)
      : {action: 'upload', notes, reasons: ['baseline'], triggersChanged: true}
  }

  if (active.versionId === entry.versionId) return compareToState(worker, entry)
  // The tag of this very bundle means the crashed run already deployed what this plan would.
  if (active.tag === tagFor(worker.fingerprint)) return stateBehind(triggersOnly(worker, entry))
  if (active.tag === tagFor(entry.fingerprint)) return stateBehind(compareToState(worker, entry))
  if (active.triggeredBy !== 'secret') {
    return drifted(worker, entry, {message: "The active version isn't the one in the state manifest, and its tag doesn't match.", split: false}, onDrift)
  }

  // A secret version copies the latest upload, so a rotation on top of a manual deploy keeps that code live.
  if (active.sourceTag === tagFor(entry.fingerprint)) return secretChanged(worker, entry)
  return drifted(worker, entry, {message: "A secret command made the active version, on top of code the state manifest doesn't name.", split: false}, onDrift)
}

/** A request to Cloudflare per worker that needs it: the tag only matters when the version alone doesn't settle things. */
export function needsTag(active: ActiveInfo, entry: StateWorker | undefined, deployedName: string): boolean {
  return active.state === 'active' && (entry?.deployedName !== deployedName || entry.versionId !== active.versionId)
}

function hasRoutes(triggers: Triggers | undefined): boolean {
  return (triggers?.routes.length ?? 0) > 0
}

function hasCrons(triggers: Triggers | undefined): boolean {
  return (triggers?.crons?.length ?? 0) > 0
}

function directBindingCallers(graph: Graph, worker: string): string[] {
  const edges = graph.edges.filter(({kind}) => kind !== 'queues')
  return directCallers({...graph, edges}, worker)
}

function previousVersion(active: ActiveInfo): string | undefined {
  if (active.state === 'missing') return undefined
  return active.state === 'active' ? active.versionId : active.shares[0].versionId
}

/** A blocked step stays blocked: a person has to look at it, and the need stays in the manifest for afterwards. */
function giveNewVersion(decision: Decision): void {
  if (decision.action === 'skip' || decision.action === 'adopt' || decision.action === 'triggers') {
    decision.reasons = decision.action === 'triggers' ? [...decision.reasons, 'provider-recreated'] : ['provider-recreated']
    decision.action = 'upload'
  } else if (decision.action === 'upload' && !decision.reasons.includes('provider-recreated')) {
    decision.reasons = [...decision.reasons, 'provider-recreated']
  }
}

/**
 * A deleted and recreated provider leaves its callers broken until they get a new version, and only a new one: redeploying
 * the old version doesn't help. So a caller that would otherwise get no new version gets one. Queue edges hold no binding.
 * The need outlives this plan through the manifest's `needsNewVersion`, which `apply` writes before the provider exists.
 */
function uploadCallersOfRecreated(
  decisions: Map<string, Decision>,
  {graph, ignored, marked, recreated}: {graph: Graph; ignored: PlanOptions['ignored']; marked: string[]; recreated: string[]},
): PlanNote[] {
  const notes: PlanNote[] = []
  const ignoredNames = new Set(ignored?.workers)
  const ignoredNote = (caller: string, why: string): PlanNote => ({
    kind: 'caller-ignored',
    message: `${why}, and it's in .monocfignore, so monocf leaves it alone. It stays broken until someone gives it a new version.`,
    worker: caller,
  })
  for (const provider of recreated) {
    for (const caller of directBindingCallers(graph, provider)) {
      const decision = decisions.get(caller)
      if (decision) {
        giveNewVersion(decision)
      } else {
        const message = `It calls ${provider}, which is being recreated, so it needs a new version, but it isn't selected.`
        notes.push({kind: 'caller-not-selected', message, worker: caller})
      }
    }

    if (ignored) {
      for (const caller of directBindingCallers(ignored.graph, provider)) {
        if (ignoredNames.has(caller)) notes.push(ignoredNote(caller, `It calls ${provider}, which is being recreated`))
      }
    }
  }

  for (const caller of marked) {
    const decision = decisions.get(caller)
    if (decision) {
      giveNewVersion(decision)
    } else if (ignoredNames.has(caller)) {
      notes.push(ignoredNote(caller, 'A provider it calls was recreated'))
    } else {
      const message = "A provider it calls was recreated, so it needs a new version, but it isn't selected."
      notes.push({kind: 'caller-not-selected', message, worker: caller})
    }
  }

  return notes
}

/**
 * `versions upload` refuses a site, and it would leave a container's image behind with exit 0, so these take `deploy`. It
 * also refuses pending migrations, and for a live worker with no state entry nothing says which have been applied.
 */
function routeToDeploy(decision: Decision, worker: ManifestWorker, entry: StateWorker | undefined): void {
  if (decision.action !== 'upload') return
  if (worker.needsDeploy?.length) {
    decision.action = 'full-deploy'
    decision.reasons = [...decision.reasons, 'needs-deploy']
  } else if (!entry && worker.hasMigrations) {
    decision.action = 'full-deploy'
  }
}

/**
 * A real account with no such worker answers 10007, as a first run does. These are the cases that can't be told apart, each
 * with the flag that says it's meant. Nothing has been deployed by the time this says no.
 */
function refusal(
  {accountHashes, allowRecreate, firstRun}: PlanGuards,
  {active, entryOf, names, state}: {active: Record<string, ActiveInfo>; entryOf: (name: string) => StateWorker | undefined; names: string[]; state: null | StateManifest},
): string | undefined {
  const isMissing = (name: string) => active[name].state === 'missing'
  if (!allowRecreate) {
    const other = names.find((name) => {
      const stored = entryOf(name)?.accountHash
      const current = accountHashes[name]
      return stored !== undefined && current !== undefined && stored !== current
    })
    if (other !== undefined) {
      return `The account for ${other} isn't the one that last deployed it. Check account_id and CLOUDFLARE_ACCOUNT_ID. If this move is meant, pass --allow-recreate.`
    }

    const known = names.filter((name) => entryOf(name) !== undefined)
    const gone = known.filter((name) => isMissing(name))
    if (known.length >= 2 && gone.length * 2 > known.length) {
      return `${gone.length} of the ${known.length} workers the state knows read as missing, which is what the wrong account looks like. Check account_id and CLOUDFLARE_ACCOUNT_ID. If they were really deleted, pass --allow-recreate.`
    }
  }

  if (!firstRun && state === null && names.length > 0 && names.every((name) => isMissing(name))) {
    return "There's no state, and no worker is live, which is what the wrong account or a wrong state location looks like. Check them. If this is the first run for this env, pass --first-run."
  }

  return undefined
}

/** What stays on Cloudflare after this worker's step, for a person to remove: a last route, or a worker under its old name. */
function leftBehindNotes(name: string, worker: ManifestWorker, entry: StateWorker | undefined, old: StateWorker | undefined): PlanNote[] {
  const notes: PlanNote[] = []
  if (hasRoutes(entry?.triggers) && !hasRoutes(worker.triggers)) {
    // Wrangler only publishes a list with something in it. With no zone to check this against, a person has to do it.
    const message = 'It no longer has a route, and removing the last one takes a person: wrangler leaves it attached.'
    notes.push({kind: 'routes-removed', message, worker: name})
  }

  if (old && !entry) {
    const message = `It now deploys as ${worker.deployedName}. The old name stays deployed until someone removes it.`
    notes.push({deployedName: old.deployedName, kind: 'renamed', message, worker: name})
  }

  return notes
}

function compareNotes(a: PlanNote, b: PlanNote): number {
  const key = (note: PlanNote) => `${note.kind}\n${note.worker}\n${note.message}`
  return key(a) < key(b) ? -1 : Number(key(a) > key(b))
}

/**
 * Compares what this commit would upload with what is live, and says what each selected worker needs. Pure: the same inputs
 * give the same plan. The bundle holds exactly the selected workers, the graph every worker that isn't ignored.
 */
// eslint-disable-next-line max-params
export function createPlan(
  bundle: PlanBundle,
  state: null | StateManifest,
  active: Record<string, ActiveInfo>,
  graph: Graph,
  {createdAt, guards, ignored, onDrift, repositoryWorkers, state: stateUrl}: PlanOptions,
): Plan {
  const stored = new Map(Object.entries(state?.workers ?? {}))
  const order = computeOrder(graph).levels.flat()
  const names = order.filter((name) => Object.hasOwn(bundle.workers, name))
  const unplaced = Object.keys(bundle.workers).find((name) => !order.includes(name))
  if (unplaced !== undefined) throw new Error(`Worker ${unplaced} is in the bundle but not in the graph.`)

  const notes: PlanNote[] = []
  const decisions = new Map<string, Decision>()
  const recreated: string[] = []
  const entryOf = (name: string): StateWorker | undefined => {
    const entry = stored.get(name)
    // A new deployed name is a new worker. The state of the old name says nothing about it.
    return entry?.deployedName === bundle.workers[name].deployedName ? entry : undefined
  }

  for (const name of names) {
    const worker = bundle.workers[name]
    const entry = entryOf(name)
    const decision = classify(worker, entry, active[name], onDrift)
    decisions.set(name, decision)
    notes.push(...decision.notes.map((note) => ({...note, worker: name})))
    if (decision.action === 'create' && entry) recreated.push(name)
    notes.push(...leftBehindNotes(name, worker, entry, stored.get(name)))
  }

  // A name gone from the repository needs nothing: the orphan note covers it.
  const marked = (state?.needsNewVersion ?? []).filter((name) => repositoryWorkers.includes(name))
  notes.push(...uploadCallersOfRecreated(decisions, {graph, ignored, marked, recreated}))
  for (const name of names) routeToDeploy(decisions.get(name)!, bundle.workers[name], entryOf(name))

  for (const [name, entry] of stored) {
    if (!repositoryWorkers.includes(name)) {
      const message = 'The state manifest knows this worker, but it is gone from the repository. monocf never deletes it.'
      notes.push({deployedName: entry.deployedName, kind: 'orphan', message, worker: name})
    }
  }

  const deploying = names.filter((name) => {
    const {action} = decisions.get(name)!
    return action !== 'skip' && action !== 'adopt'
  })
  const dependencies = nearestWithin(graph, deploying)

  const steps = names.map((name): PlanStep => {
    const worker = bundle.workers[name]
    const {action, reasons, recordState, triggersChanged} = decisions.get(name)!
    const previousVersionId = previousVersion(active[name])
    return {
      worker: name,
      deployedName: worker.deployedName,
      action,
      reasons,
      ...(recordState && {recordState}),
      triggersChanged,
      explicitEmptyCrons: hasCrons(entryOf(name)?.triggers) && !hasCrons(worker.triggers),
      fingerprint: worker.fingerprint,
      ...(recreated.includes(name) && {markCallers: directBindingCallers(graph, name)}),
      bundleHash: worker.bundleHash,
      configHash: worker.configHash,
      externalHash: worker.externalHash,
      triggers: worker.triggers,
      triggersHash: worker.triggersHash,
      doHash: worker.doHash,
      ...(worker.version !== undefined && {version: worker.version}),
      ...(previousVersionId !== undefined && {previousVersionId}),
      dependsOn: dependencies.get(name) ?? [],
      callers: directCallers(graph, name),
      transitiveCallers: callers(graph, name),
    }
  })

  const refused = guards && refusal(guards, {active, entryOf, names, state})
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    env: bundle.env,
    commit: bundle.commit,
    createdAt,
    state: stateUrl,
    wrangler: bundle.wrangler,
    ...(guards && {accounts: guards.accounts}),
    applicable: refused === undefined && steps.every(({action}) => action !== 'blocked'),
    ...(refused !== undefined && {refused}),
    steps,
    notes: notes.sort(compareNotes),
  }
}
