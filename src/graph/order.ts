import type {Graph} from './graph.js'

export interface Order {
  /** Cycles, including a worker that targets itself. Ordering inside a cycle is undefined. */
  cycles: string[][]
  /** Groups that can run in parallel, callees first. Members of one cycle share a level. */
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

/** Orders a graph into levels and reports its cycles. Levels and their members are stable and sorted. */
export function computeOrder(graph: Graph): Order {
  const callees = adjacency(graph, 'from', 'to')
  const components = stronglyConnectedComponents(graph.nodes, callees)

  const levelOf = new Map<string, number>()
  const levels: string[][] = []
  const cycles: string[][] = []
  for (const component of components) {
    const members = new Set(component)
    const outside = component.flatMap((member) => (callees.get(member) ?? []).filter((callee) => !members.has(callee)))
    const level = Math.max(-1, ...outside.map((callee) => levelOf.get(callee)!)) + 1
    for (const member of component) levelOf.set(member, level)
    levels[level] = [...(levels[level] ?? []), ...component]

    const [first] = component
    if (component.length > 1 || callees.get(first)?.includes(first)) cycles.push(component)
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
