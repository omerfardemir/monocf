import {describe, expect, it} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

const debugMarkers = ['currentDir', 'configPath', 'return null', 'Ignore file not found', 'tempWranglerConfigPath']

describe('CLI output', () => {
  it.each([
    ['a single worker', ['worker', 'orders', '-c', 'build']],
    ['all workers', ['worker', '-a', '-c', 'build']],
  ])('build of %s prints no debug output or resolved config', async (_, args) => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})

    const result = await runCli(fixture, args)

    expect(result.exitCode).toBe(0)
    for (const marker of debugMarkers) {
      expect(result.stdout).not.toContain(marker)
    }

    expect(result.stdout).not.toContain(fixture.root)
    expect(result.stdout).not.toContain('{')
  })

  it('deploy prints no debug output', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])

    expect(result.exitCode).toBe(0)
    for (const marker of debugMarkers) {
      expect(result.stdout).not.toContain(marker)
    }
  })
})

describe('removed commands', () => {
  it.each(['start', 'stop'])('docker %s no longer exists', async (subcommand) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['docker', subcommand])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('not found')
    expect(result.calls).toEqual([])
  })
})
