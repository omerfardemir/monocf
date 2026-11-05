import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {describeGraph, formatGraph, formatMermaid} from '../graph/view.js'
import type {OptionFlags} from '../project/options.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {loadOptions, selectAll} from './project.js'

export interface GraphFlags extends OptionFlags {
  callers?: string
  json?: boolean
  mermaid?: boolean
}

function writeNotices(messages: string[]): void {
  for (const message of messages) process.stderr.write(`notice: ${message}\n`)
}

/** `monocf graph`: reads configs and prints. It needs no wrangler and no credentials. */
export function runGraph(flags: GraphFlags): void {
  const options = loadOptions(flags)
  const selection = selectAll(options)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selection.selected, options, inputs, project)

  const workers = project.workers.filter(({dir}) => selection.selected.includes(dir))
  const view = describeGraph(workers, selection.ignored, options.env)
  writeNotices(project.notices.filter(({worker}) => selection.selected.includes(worker)).map(({message}) => message))

  if (flags.callers !== undefined) {
    const node = view.nodes.find(({name}) => name === flags.callers)
    if (!node) throw new ConfigError(`Worker not found: ${flags.callers}. Please check the worker name.`)
    const {callers, name, transitiveCallers} = node
    const result = {callers, schemaVersion: SCHEMA_VERSION, transitiveCallers, worker: name}
    const text = flags.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : transitiveCallers.map((caller) => `${caller}\n`).join('')
    process.stdout.write(text)
    return
  }

  if (flags.json) process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
  else process.stdout.write(flags.mermaid ? formatMermaid(view) : formatGraph(view))
}
