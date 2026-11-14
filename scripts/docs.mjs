// Writes the tables of codes into docs/json-output.md from the registry `monocf explain` reads. Run after npm run build.
import {readFileSync, writeFileSync} from 'node:fs'

import {formatCodesMarkdown} from '../dist/explain/markdown.js'

const path = new URL('../docs/json-output.md', import.meta.url)
const doc = readFileSync(path, 'utf8')
const updated = doc.replace(/<!-- codes -->[\s\S]*<!-- codesstop -->/, `<!-- codes -->\n${formatCodesMarkdown()}<!-- codesstop -->`)
writeFileSync(path, updated)
