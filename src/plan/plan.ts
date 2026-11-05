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
  | 'split'
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
  /** WP6 writes `"crons": []` for this step: with the key absent, wrangler would leave the removed crons running. */
  explicitEmptyCrons: boolean
  externalHash: string
  fingerprint: string
  /** The version Cloudflare serves now, or the largest share of a split rollout. Absent when the worker doesn't exist. */
  previousVersionId?: string
  reasons: PlanReason[]
  transitiveCallers: string[]
  triggers: Triggers
  /** The triggers need applying: they changed, or nothing says what is live. */
  triggersChanged: boolean
  triggersHash: string
  version?: string
  worker: string
}

export type PlanNoteKind = 'baseline' | 'caller-not-selected' | 'drift' | 'orphan' | 'recreated' | 'renamed' | 'state-behind'

export interface PlanNote {
  deployedName?: string
  kind: PlanNoteKind
  message: string
  worker: string
}

export interface Plan {
  /** False when any step is blocked, so `apply` refuses the plan. */
  applicable: boolean
  commit: string
  createdAt: string
  env: string
  notes: PlanNote[]
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

export interface PlanOptions {
  createdAt: string
  onDrift: OnDrift
  /** Every worker directory in the repository, ignored ones too. A state entry for anything else is an orphan. */
  repositoryWorkers: string[]
  state: string
}

interface Decision {
  action: PlanAction
  notes: Omit<PlanNote, 'worker'>[]
  reasons: PlanReason[]
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
function drifted(worker: ManifestWorker, entry: StateWorker | undefined, split: boolean, onDrift: OnDrift): Decision {
  const message = split ? 'A split rollout is live.' : "The active version isn't the one in the state manifest, and its tag doesn't match."
  const reasons: PlanReason[] = ['drift', ...(split ? (['split'] as const) : [])]
  const notes = [{kind: 'drift' as const, message}]
  if (onDrift === 'fail') return blocked(reasons, notes)

  const base = entry ? compareToState(worker, entry) : undefined
  if (base?.action === 'full-deploy' || base?.action === 'upload') {
    return {...base, notes, reasons: [...reasons, ...base.reasons], triggersChanged: true}
  }

  return {action: 'upload', notes, reasons, triggersChanged: true}
}

/** The manifest is behind what is live, but the tag shows monocf put it there: a run that crashed before writing state. */
function stateBehind(decision: Decision): Decision {
  const message = 'The active version carries the expected tag, but the state manifest names another. A previous run likely stopped before writing state.'
  return {...decision, notes: [{kind: 'state-behind', message}]}
}

function classify(worker: ManifestWorker, entry: StateWorker | undefined, active: ActiveInfo, onDrift: OnDrift): Decision {
  if (active.state === 'missing') {
    const notes = entry ? [{kind: 'recreated' as const, message: 'The state manifest knows this worker, but it no longer exists on Cloudflare.'}] : []
    return {action: 'create', notes, reasons: ['new'], triggersChanged: true}
  }

  if (active.state === 'split') return drifted(worker, entry, true, onDrift)

  if (!entry) {
    if (active.tag === tagFor(worker.fingerprint)) {
      return {action: 'adopt', notes: [], reasons: ['state-missing'], triggersChanged: false}
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
  return drifted(worker, entry, false, onDrift)
}

/** A request to Cloudflare per worker that needs it: the tag only matters when the version alone doesn't settle things. */
export function needsTag(active: ActiveInfo, entry: StateWorker | undefined, deployedName: string): boolean {
  return active.state === 'active' && (entry?.deployedName !== deployedName || entry.versionId !== active.versionId)
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

/**
 * A deleted and recreated provider leaves its callers broken until they get a new version, and only a new one: redeploying
 * the old version doesn't help. So a caller that would otherwise get no new version gets one. Queue edges hold no binding.
 */
function uploadCallersOfRecreated(decisions: Map<string, Decision>, recreated: string[], graph: Graph): PlanNote[] {
  const notes: PlanNote[] = []
  for (const provider of recreated) {
    for (const caller of directBindingCallers(graph, provider)) {
      const decision = decisions.get(caller)
      if (!decision) {
        const message = `It calls ${provider}, which is being recreated, so it needs a new version, but it isn't selected.`
        notes.push({kind: 'caller-not-selected', message, worker: caller})
      } else if (decision.action === 'skip' || decision.action === 'adopt' || decision.action === 'triggers') {
        decision.reasons = decision.action === 'triggers' ? [...decision.reasons, 'provider-recreated'] : ['provider-recreated']
        decision.action = 'upload'
      } else if (decision.action === 'upload' && !decision.reasons.includes('provider-recreated')) {
        decision.reasons = [...decision.reasons, 'provider-recreated']
      }
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
  {createdAt, onDrift, repositoryWorkers, state: stateUrl}: PlanOptions,
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

    const old = stored.get(name)
    if (old && !entry) {
      const message = `It now deploys as ${worker.deployedName}. The old name stays deployed until someone removes it.`
      notes.push({deployedName: old.deployedName, kind: 'renamed', message, worker: name})
    }
  }

  notes.push(...uploadCallersOfRecreated(decisions, recreated, graph))
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
    const {action, reasons, triggersChanged} = decisions.get(name)!
    const previousVersionId = previousVersion(active[name])
    return {
      worker: name,
      deployedName: worker.deployedName,
      action,
      reasons,
      triggersChanged,
      explicitEmptyCrons: hasCrons(entryOf(name)?.triggers) && !hasCrons(worker.triggers),
      fingerprint: worker.fingerprint,
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

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    env: bundle.env,
    commit: bundle.commit,
    createdAt,
    state: stateUrl,
    wrangler: bundle.wrangler,
    applicable: steps.every(({action}) => action !== 'blocked'),
    steps,
    notes: notes.sort(compareNotes),
  }
}
