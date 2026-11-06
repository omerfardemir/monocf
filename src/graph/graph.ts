import {envSection} from '../config/resolve.js'
import {isPlainObject, type BindingSource, type RawConfig, type ResolvedWorker} from '../config/types.js'

export type EdgeKind = BindingSource | 'queues'

/** `from` calls `to`, so `to` deploys first. */
export interface Edge {
  from: string
  kind: EdgeKind
  to: string
  /** The binding name, or the queue name for a queue edge. */
  via: string
}

export interface ExternalBinding {
  binding: string
  name: string
  source: BindingSource
  worker: string
}

export interface Graph {
  edges: Edge[]
  external: ExternalBinding[]
  nodes: string[]
}

function queueEntries(entries: unknown): RawConfig[] {
  return Array.isArray(entries) ? entries.filter((entry): entry is RawConfig => isPlainObject(entry)) : []
}

function queueNames(entries: RawConfig[], field: string): string[] {
  return entries.flatMap((entry) => {
    const queue = entry[field]
    return typeof queue === 'string' ? [queue] : []
  })
}

function queueFields(config: RawConfig, env?: string): {consumers: RawConfig[]; producers: RawConfig[]} {
  const {queues} = envSection(config, env)
  return isPlainObject(queues)
    ? {consumers: queueEntries(queues.consumers), producers: queueEntries(queues.producers)}
    : {consumers: [], producers: []}
}

/** A worker sends to the queues it produces to and, when it fails a message, to the dead letter queue of its consumer. */
function queueEdges(workers: ResolvedWorker[]): Edge[] {
  const consumersByQueue = new Map<string, string[]>()
  for (const {config, dir, env} of workers) {
    for (const queue of queueNames(queueFields(config, env).consumers, 'queue')) {
      consumersByQueue.set(queue, [...(consumersByQueue.get(queue) ?? []), dir])
    }
  }

  return workers.flatMap(({config, dir, env}) => {
    const {consumers, producers} = queueFields(config, env)
    return [...queueNames(producers, 'queue'), ...queueNames(consumers, 'dead_letter_queue')].flatMap((queue) =>
      (consumersByQueue.get(queue) ?? []).map((to) => ({from: dir, kind: 'queues' as const, to, via: queue})),
    )
  })
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareEdges(a: Edge, b: Edge): number {
  return (
    compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.kind, b.kind) || compareText(a.via, b.via)
  )
}

/** Builds the graph from resolved workers. Output order doesn't depend on input order. */
export function buildGraph(workers: ResolvedWorker[]): Graph {
  const nodes = new Set(workers.map(({dir}) => dir))
  const bindingEdges: Edge[] = []
  const external: ExternalBinding[] = []
  for (const {bindings, dir} of workers) {
    for (const {binding, source, target} of bindings) {
      if (target.kind === 'local') {
        // The resolver fails a worker whose target failed, so a missing node means the caller passed a partial list.
        if (nodes.has(target.dir)) bindingEdges.push({from: dir, kind: source, to: target.dir, via: binding})
      } else {
        external.push({binding, name: target.name, source, worker: dir})
      }
    }
  }

  return {
    edges: [...bindingEdges, ...queueEdges(workers)].sort(compareEdges),
    external: external.sort(
      (a, b) => compareText(a.worker, b.worker) || compareText(a.source, b.source) || compareText(a.binding, b.binding),
    ),
    nodes: [...nodes].sort(compareText),
  }
}
