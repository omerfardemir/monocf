import {dirname, join, resolve} from 'node:path'

import type {FileReader} from '../../src/project/load.js'

export const projectRoot = resolve('/project')

/** An in-memory project, keyed by paths relative to the root. Objects are stored as JSON. */
export function memoryReader(files: Record<string, unknown>): FileReader & {reads: Map<string, number>} {
  const contents = new Map<string, string>()
  const dirs = new Map<string, Set<string>>()
  for (const [path, value] of Object.entries(files)) {
    const absolute = join(projectRoot, path)
    contents.set(absolute, typeof value === 'string' ? value : JSON.stringify(value))
    let child = absolute
    while (child !== projectRoot) {
      const parent = dirname(child)
      dirs.set(parent, (dirs.get(parent) ?? new Set()).add(child.slice(parent.length).replace(/^[/\\]/, '')))
      child = parent
    }
  }

  const reads = new Map<string, number>()
  return {
    exists: (path) => contents.has(path) || dirs.has(path),
    readDir: (path) => [...(dirs.get(path) ?? [])],
    readFile(path) {
      reads.set(path, (reads.get(path) ?? 0) + 1)
      const content = contents.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    reads,
  }
}
