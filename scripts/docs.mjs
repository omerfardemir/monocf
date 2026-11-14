// A table of codes that a person edits by hand drifts from what `monocf explain` says, so the tables in the README and in
// docs/json-output.md are written from the registry. It imports dist, so run it after npm run build.
import {readFileSync, writeFileSync} from 'node:fs'

import {formatCodesMarkdown, formatReadmeTables, replaceMarked} from '../dist/explain/markdown.js'

const targets = [
  [new URL('../docs/json-output.md', import.meta.url), {codes: formatCodesMarkdown()}],
  [new URL('../README.md', import.meta.url), formatReadmeTables()],
]

for (const [path, tables] of targets) {
  const text = readFileSync(path, 'utf8')
  const updated = replaceMarked(text, tables)
  if (updated !== text) writeFileSync(path, updated)
}
