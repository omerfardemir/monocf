import type {ResolvedWorker} from '../config/types.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {buildGraph, type EdgeKind, type ExternalBinding, type Graph} from './graph.js'
import {callers, computeOrder, directCallers} from './order.js'

export interface GraphNode {
  callers: string[]
  deployedName: string
  name: string
  transitiveCallers: string[]
}

export interface GraphView {
  cycles: string[][]
  edges: {binding: string; from: string; kind: EdgeKind; to: string}[]
  env: null | string
  external: ExternalBinding[]
  ignored: string[]
  levels: string[][]
  nodes: GraphNode[]
  schemaVersion: number
}

/** The graph of the deployable workers. A worker in the ignore list is no node, and an edge to it is no edge here. */
export function describeGraph(workers: ResolvedWorker[], ignored: string[], env?: string): GraphView {
  const graph: Graph = buildGraph(workers)
  const {cycles, levels} = computeOrder(graph)
  return {
    cycles,
    edges: graph.edges.map(({from, kind, to, via}) => ({binding: via, from, kind, to})),
    env: env ?? null,
    external: graph.external,
    ignored: [...ignored].sort(),
    levels,
    nodes: graph.nodes.map((name) => ({
      callers: directCallers(graph, name),
      deployedName: workers.find(({dir}) => dir === name)!.deployedName,
      name,
      transitiveCallers: callers(graph, name),
    })),
    schemaVersion: SCHEMA_VERSION,
  }
}

/** Levels, callees first, with what each worker reaches. */
export function formatGraph(view: GraphView): string {
  const lines = view.levels.flatMap((level, index) => [
    `Level ${index}:`,
    ...level.flatMap((worker) => [
      `  ${worker}`,
      ...view.edges
        .filter(({from}) => from === worker)
        .map(({binding, kind, to}) => `    -> ${to} (${kind}: ${binding})`),
      ...view.external
        .filter((external) => external.worker === worker)
        .map(({binding, name, source}) => `    external: ${name} (${source}: ${binding})`),
    ]),
  ])
  if (view.cycles.length > 0) lines.push(`Cycles: ${view.cycles.map((cycle) => cycle.join(', ')).join('; ')}`)
  if (view.ignored.length > 0) lines.push(`Ignored: ${view.ignored.join(', ')}`)
  return `${lines.join('\n')}\n`
}

function mermaidLabel(text: string): string {
  return text.replaceAll('"', '#quot;').replaceAll('|', '#124;')
}

/** A flowchart with callers above callees. Queue edges are dotted, as nothing calls through them directly. */
export function formatMermaid(view: GraphView): string {
  const ids = new Map(view.nodes.map(({name}, index) => [name, `n${index}`]))
  const lines = [
    'flowchart TD',
    ...view.nodes.map(({name}) => `  ${ids.get(name)}["${mermaidLabel(name)}"]`),
    ...view.edges.map(({binding, from, kind, to}) => {
      const arrow = kind === 'queues' ? '-.->' : '-->'
      return `  ${ids.get(from)} ${arrow}|"${mermaidLabel(`${kind}: ${binding}`)}"| ${ids.get(to)}`
    }),
  ]
  return `${lines.join('\n')}\n`
}
