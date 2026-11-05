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

function queueNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry: unknown) => {
    const queue = isPlainObject(entry) ? entry.queue : undefined
    return typeof queue === 'string' ? [queue] : []
  })
}

function queueFields(config: RawConfig, env?: string): {consumers: string[]; producers: string[]} {
  const {queues} = envSection(config, env)
  return isPlainObject(queues)
    ? {consumers: queueNames(queues.consumers), producers: queueNames(queues.producers)}
    : {consumers: [], producers: []}
}

function queueEdges(workers: ResolvedWorker[]): Edge[] {
  const consumersByQueue = new Map<string, string[]>()
  for (const {config, dir, env} of workers) {
    for (const queue of queueFields(config, env).consumers) {
      consumersByQueue.set(queue, [...(consumersByQueue.get(queue) ?? []), dir])
    }
  }

  return workers.flatMap(({config, dir, env}) =>
    queueFields(config, env).producers.flatMap((queue) =>
      (consumersByQueue.get(queue) ?? []).map((to) => ({from: dir, kind: 'queues' as const, to, via: queue})),
    ),
  )
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
        // A target outside the nodes failed to resolve, and project.failures reports it.
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
