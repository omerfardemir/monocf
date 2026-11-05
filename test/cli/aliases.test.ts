import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type CliResult, type Fixture} from '../helpers/harness.js'

const environments = ['staging']
// Each fixture has its own commit, whose hash changes with the clock.
const sameCommit = {env: {GITHUB_SHA: 'abc1234'}}

function project(): Fixture {
  return createFixture({
    environments,
    files: {'workers/orders/.dev.vars.staging': 'TOKEN=abc\n'},
    workers: [{envBindings: {staging: ['billing']}, name: 'orders', version: '1.4.0'}, {name: 'billing'}],
  })
}

/** Without what differs between two runs: where the fixture is, and the random run ID. */
function portable({root}: Fixture, text: string): string {
  return text
    .replaceAll(/\\+/g, '/')
    .replaceAll(root.replaceAll('\\', '/'), '<root>')
    .replaceAll(/\.monocf\/runs\/[^/]+/g, '.monocf/runs/<id>')
}

/** What wrangler was asked to do, in an order that doesn't depend on timing. */
function wranglerCalls(fixture: Fixture, result: CliResult): string[] {
  return result.calls
    .map(({argv, config, cwd, secretFile}) => portable(fixture, JSON.stringify({argv, config, cwd, secret: secretFile?.vars})))
    .sort()
}

describe('monocf build, deploy, preview and dev', () => {
  it.each([
    ['build', ['orders', '-e', 'staging', '--minify']],
    ['build', ['-a', '-e', 'staging', '--concurrency', '2']],
    ['deploy', ['orders', '-e', 'staging', '--deploy-bindings', '-M', 'a message']],
    ['deploy', ['orders', '-e', 'staging', '--no-deploy-bindings', '-s']],
    ['deploy', ['-a', '-e', 'staging', '--concurrency', '2']],
    ['deploy', ['orders', '-e', 'staging', '-f', '-F', 'abc123']],
    ['preview', ['orders', '-e', 'staging', '-M', 'a message', '-d']],
    ['dev', ['orders', '-e', 'staging', '-p', '9000']],
    ['dev', ['-a', '-p', '8123']],
  ])('%s %j makes the same wrangler calls as worker -c', async (action, args) => {
    const [first, second] = [project(), project()]

    const direct = await runCli(first, [action, ...args], sameCommit)
    const old = await runCli(second, ['worker', '-c', action, ...args], sameCommit)

    expect(old.exitCode).toBe(direct.exitCode)
    expect(portable(second, old.stdout)).toBe(portable(first, direct.stdout))
    expect(wranglerCalls(second, old)).toEqual(wranglerCalls(first, direct))
  })

  it.each([
    ['build', ['orders', '-e', 'staging', '--port', '9000']],
    ['build', ['nope', '-e', 'staging']],
    ['deploy', ['orders', '-e', 'nope']],
  ])('%s %j fails the same way as worker -c', async (action, args) => {
    const fixture = project()

    const direct = await runCli(fixture, [action, ...args], {noCalls: true})
    const old = await runCli(fixture, ['worker', '-c', action, ...args], {noCalls: true})

    expect(direct.exitCode).toBe(2)
    expect(old.exitCode).toBe(2)
    expect(old.stderr).toContain(direct.stderr.trim())
  })

  it('makes wrangler calls at all, so the comparison above means something', async () => {
    const result = await runCli(project(), ['deploy', 'orders', '-e', 'staging', '--deploy-bindings'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.calls.map(({argv}) => argv[0])).toEqual(['deploy', 'deploy'])
  })

  it('worker -c prints one deprecation line on stderr, and the new form prints none', async () => {
    const fixture = project()

    const direct = await runCli(fixture, ['build', 'orders', '-e', 'staging'])
    const old = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'staging'])

    const notice = '"monocf worker -c build" is deprecated. Use "monocf build".'
    expect(direct.stderr).not.toContain('deprecated')
    expect(old.stderr.split(/\r?\n/).filter((line) => line.includes('deprecated'))).toEqual([notice])
  })

  it('worker -c keeps stdout clean under --json', async () => {
    const result = await runCli(project(), ['worker', 'orders', '-c', 'build', '-e', 'staging', '--json'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('deprecated')
    for (const line of result.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('worker create stays a command of its own, with no deprecation notice', async () => {
    const fixture = project()

    const created = await runCli(fixture, ['worker', 'create', 'reports'], {noCalls: true})

    expect(created.exitCode, created.stderr).toBe(0)
    expect(created.stderr).not.toContain('deprecated')
  })
})
