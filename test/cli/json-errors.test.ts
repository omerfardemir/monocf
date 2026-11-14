import {stripVTControlCharacters} from 'node:util'
import {describe, expect, it} from 'vitest'

import {ERROR_CODES} from '../../src/explain/registry.js'
import {createFixture, runCli, type CliResult} from '../helpers/harness.js'

const workers = [{name: 'billing'}, {name: 'orders'}]

/** Exactly one line on stdout, and it's an error event that agrees with the exit code. */
function onlyErrorEvent(result: CliResult): Record<string, unknown> {
  const lines = result.stdout.split('\n').filter(Boolean)
  expect(lines, result.stdout).toHaveLength(1)
  const event = JSON.parse(lines[0])
  expect(event).toMatchObject({schemaVersion: 1, type: 'error'})
  expect(Object.hasOwn(ERROR_CODES, event.code), event.code).toBe(true)
  expect(event.exitCode).toBe(result.exitCode)
  expect(result.exitCode).not.toBe(0)
  expect(typeof event.message).toBe('string')
  expect(event.message).not.toContain('See more help')
  expect(event.message).toBe(stripVTControlCharacters(event.message as string))
  return event
}

describe('every failure under --json', () => {
  it.each([
    ['a missing required flag', ['plan', '-e', 'dev', '--json'], 'missing-flag', 'Run monocf plan --help.'],
    ['an unknown flag', ['check', '--bogus', '--json'], 'unknown-flag', 'Run monocf check --help.'],
    ['an unknown flag of a command in a topic', ['secrets', 'check', '--bogus', '--json'], 'unknown-flag', 'Run monocf secrets check --help.'],
    ['an unknown command', ['nope', '--json'], 'unknown-command', 'Run monocf commands --json to list the commands.'],
    ['an unknown command in a topic', ['secrets', 'nope', '--json'], 'unknown-command', undefined],
    ['a topic with no command', ['secrets', '--json'], 'command-needed', 'Run one of: monocf secrets check, monocf secrets deploy.'],
    ['a flag value that is not an integer', ['bundle', '-e', 'dev', '--concurrency', 'x', '--json'], 'invalid-flag-value', undefined],
    ['a value that is not an option', ['plan', '-e', 'dev', '--state', 'file:state', '--on-drift', 'maybe', '--json'], 'invalid-flag-value', undefined],
    ['flags that exclude each other', ['graph', '--json', '--mermaid'], 'flag-conflict', undefined],
    ['a missing argument', ['apply', '--json'], 'missing-argument', undefined],
    ['an unexpected argument', ['apply', 'plan.json', 'extra', '--json'], 'unexpected-argument', 'Run monocf apply --help.'],
    // oclif reads words after a command that takes no argument as a longer command's name.
    ['an argument to a command that takes none', ['check', 'extra', '--json'], 'unknown-command', undefined],
    ['a flag with no value', ['plan', '-e', 'dev', '--json', '--state'], 'invalid-flag-value', undefined],
  ])('gives one error event for %s', async (_, args, code, hint) => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, args, {noCalls: true})

    const event = onlyErrorEvent(result)
    expect(event.code).toBe(code)
    expect(event.exitCode).toBe(2)
    if (hint !== undefined) expect(event.hint).toBe(hint)
    // The message for people is where it was.
    expect(result.stderr).not.toBe('')
  })

  it('gives the code of a failure monocf itself finds', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['plan', '-e', 'dev', '--state', 'ftp://bucket', '--json'], {noCalls: true})

    expect(onlyErrorEvent(result)).toMatchObject({
      code: 'state-scheme-unsupported',
      exitCode: 2,
      hint: 'Use file:<dir> or r2://<bucket>/<prefix>.',
    })
  })

  it('gives the code of a document command too', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['graph', '--callers', 'nope', '--json'], {noCalls: true})

    expect(onlyErrorEvent(result)).toMatchObject({code: 'worker-not-found', exitCode: 2})
  })

  it('gives the code of a failed wrangler as the last event of a run', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['deploy', 'orders', '--json'], {rules: [{command: 'deploy', exitCode: 7}]})

    const events = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(result.exitCode).toBe(1)
    expect(events.at(-1)).toMatchObject({code: 'wrangler-failed', exitCode: 1, type: 'error'})
    expect(events.filter(({type}) => type === 'error')).toHaveLength(1)
  })

  it('prints no event without --json', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['check', '--bogus'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Nonexistent flag: --bogus')
  })

  it('gives a topic with no command its help without --json', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['secrets'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('secrets check')
  })

  it('leaves a --json after -- to the command', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['nope', '--', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
  })
})
