import type {ResolvedWorker} from '../config/types.js'
import type {Graph} from './graph.js'

export interface Order {
  /** Cycles through any edge, including a worker that targets itself. */
  cycles: string[][]
  /** Groups that can run in parallel, callees first. Members of a cycle of bindings share a level. */
  levels: string[][]
}

function adjacency(graph: Graph, key: 'from' | 'to', value: 'from' | 'to'): Map<string, string[]> {
  const sets = new Map<string, Set<string>>(graph.nodes.map((node) => [node, new Set<string>()]))
  for (const edge of graph.edges) sets.get(edge[key])?.add(edge[value])
  return new Map([...sets].map(([node, targets]) => [node, [...targets].sort()]))
}

/** Tarjan's algorithm. It emits a component only after everything it reaches, so callees come first. */
function stronglyConnectedComponents(nodes: string[], callees: Map<string, string[]>): string[][] {
  const components: string[][] = []
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const visit = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    onStack.add(node)

    for (const callee of callees.get(node) ?? []) {
      if (!index.has(callee)) {
        visit(callee)
        low.set(node, Math.min(low.get(node)!, low.get(callee)!))
      } else if (onStack.has(callee)) {
        low.set(node, Math.min(low.get(node)!, index.get(callee)!))
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== node)

      components.push(component.sort())
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) visit(node)
  }

  return components
}

/**
 * The edges that decide an order. A queue edge needs no order at deploy time, so one that closes a cycle is left out, and
 * the service bindings of that cycle keep theirs.
 */
function orderingGraph(graph: Graph): Graph {
  const componentOf = new Map<string, string[]>()
  for (const component of stronglyConnectedComponents(graph.nodes, adjacency(graph, 'from', 'to'))) {
    for (const member of component) componentOf.set(member, component)
  }

  return {...graph, edges: graph.edges.filter(({from, kind, to}) => kind !== 'queues' || componentOf.get(from) !== componentOf.get(to))}
}

/** Orders a graph into levels and reports its cycles. Levels and their members are stable and sorted. */
export function computeOrder(graph: Graph): Order {
  const allCallees = adjacency(graph, 'from', 'to')
  const cycles = stronglyConnectedComponents(graph.nodes, allCallees).filter(
    (component) => component.length > 1 || allCallees.get(component[0])?.includes(component[0]),
  )

  const callees = adjacency(orderingGraph(graph), 'from', 'to')
  const levelOf = new Map<string, number>()
  const levels: string[][] = []
  for (const component of stronglyConnectedComponents(graph.nodes, callees)) {
    const members = new Set(component)
    const outside = component.flatMap((member) => (callees.get(member) ?? []).filter((callee) => !members.has(callee)))
    const level = Math.max(-1, ...outside.map((callee) => levelOf.get(callee)!)) + 1
    for (const member of component) levelOf.set(member, level)
    levels[level] = [...(levels[level] ?? []), ...component]
  }

  return {
    cycles: cycles.sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    levels: levels.map((level) => level.sort()),
  }
}

/** Everything that reaches a worker through edges, excluding the worker itself. Sorted. */
export function callers(graph: Graph, dir: string): string[] {
  const direct = adjacency(graph, 'to', 'from')
  const seen = new Set<string>([dir])
  const queue = [dir]
  while (queue.length > 0) {
    for (const caller of direct.get(queue.pop()!) ?? []) {
      if (!seen.has(caller)) {
        seen.add(caller)
        queue.push(caller)
      }
    }
  }

  seen.delete(dir)
  return [...seen].sort()
}

function reachable(callees: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    for (const callee of callees.get(queue.pop()!) ?? []) {
      if (!seen.has(callee)) {
        seen.add(callee)
        queue.push(callee)
      }
    }
  }

  return seen
}

/**
 * For each member, the other members that must finish first: any it reaches through edges, also by way of a worker
 * that isn't a member. Members of a cycle have no order between them, so they don't wait for each other.
 */
export function dependenciesWithin(graph: Graph, members: string[]): Map<string, string[]> {
  const callees = adjacency(orderingGraph(graph), 'from', 'to')
  const reach = new Map(members.map((member) => [member, reachable(callees, member)]))
  return new Map(
    members.map((member) => [
      member,
      members.filter((other) => other !== member && reach.get(member)!.has(other) && !reach.get(other)!.has(member)),
    ]),
  )
}

/**
 * For each member, the members it waits for: the nearest ones along its edges. A worker that isn't a member is looked
 * through, so an order that runs through it still holds, and a member ends the walk, since it waits for what lies behind
 * it. Members of one cycle don't wait for each other, so the result has no cycle.
 */
export function nearestWithin(graph: Graph, members: string[]): Map<string, string[]> {
  const callees = adjacency(orderingGraph(graph), 'from', 'to')
  const memberSet = new Set(members)
  const reach = new Map(members.map((member) => [member, reachable(callees, member)]))
  const nearest = (member: string): string[] => {
    const found = new Set<string>()
    const seen = new Set([member])
    const queue = [member]
    while (queue.length > 0) {
      for (const callee of callees.get(queue.pop()!) ?? []) {
        if (!seen.has(callee)) {
          seen.add(callee)
          if (memberSet.has(callee) && !reach.get(callee)!.has(member)) found.add(callee)
          else queue.push(callee)
        }
      }
    }

    return [...found].sort()
  }

  return new Map(members.map((member) => [member, nearest(member)]))
}

/** The workers with an edge to this one, excluding itself. Sorted. */
export function directCallers(graph: Graph, dir: string): string[] {
  return (adjacency(graph, 'to', 'from').get(dir) ?? []).filter((caller) => caller !== dir)
}

export interface ServiceClosure {
  /** Workers reached through service bindings, excluding the start, each before whatever binds to it. */
  reached: string[]
  /** Local targets left out because they're in `skip`. */
  skipped: string[]
  /** Reached targets that have no resolved worker. */
  unresolved: string[]
}

/** Follows service bindings to local workers, transitively. A worker in `skip` isn't followed. */
export function serviceClosure(workers: ResolvedWorker[], start: string[], skip: string[] = []): ServiceClosure {
  const byDir = new Map(workers.map((worker) => [worker.dir, worker]))
  const seen = new Set(start)
  const skipped = new Set<string>()
  const reached: string[] = []
  const unresolved: string[] = []

  const visit = (dir: string): void => {
    for (const {source, target} of byDir.get(dir)?.bindings ?? []) {
      if (source !== 'services' || target.kind !== 'local' || seen.has(target.dir)) continue
      if (skip.includes(target.dir)) {
        skipped.add(target.dir)
      } else {
        seen.add(target.dir)
        if (byDir.has(target.dir)) {
          visit(target.dir)
          reached.push(target.dir)
        } else {
          unresolved.push(target.dir)
        }
      }
    }
  }

  for (const dir of start) visit(dir)
  return {reached, skipped: [...skipped], unresolved}
}
