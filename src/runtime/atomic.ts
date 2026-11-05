import {randomBytes} from 'node:crypto'
import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'

/** Readers see the old file or the new one, never part of one. The temporary file sits next to the target to stay on its disk. */
export function writeFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), {recursive: true})
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, body)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, {force: true})
    throw error
  }
}
