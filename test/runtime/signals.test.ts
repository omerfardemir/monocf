import {describe, expect, it} from 'vitest'

import {taskkillArguments} from '../../src/runtime/signals.js'

describe('stopping a process tree on Windows', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('asks without force on %s', (signal) => {
    expect(taskkillArguments(12, signal)).toEqual(['/pid', '12', '/T'])
  })

  it('forces only for a kill', () => {
    expect(taskkillArguments(12, 'SIGKILL')).toEqual(['/pid', '12', '/T', '/F'])
  })
})
