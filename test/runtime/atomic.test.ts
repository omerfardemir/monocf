import {linkSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {writeFileAtomic} from '../../src/runtime/atomic.js'

describe('writeFileAtomic', () => {
  it('replaces the file instead of writing into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monocf-atomic-'))
    const path = join(dir, 'file')
    writeFileSync(path, 'old')
    // A second name for the same bytes. Writing into the file changes what it reads, and a rename leaves it alone.
    linkSync(path, join(dir, 'other-name'))

    writeFileAtomic(path, 'new')

    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(readFileSync(join(dir, 'other-name'), 'utf8')).toBe('old')
  })

  it('leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monocf-atomic-'))

    writeFileAtomic(join(dir, 'nested', 'file'), 'new')

    expect(readdirSync(join(dir, 'nested'))).toEqual(['file'])
  })
})
