import {describe, expect, it} from 'vitest'

import type {ReportEvent} from '../../src/report/events.js'
import {formatHuman, humanSink} from '../../src/report/human.js'
import {formatNdjson} from '../../src/report/ndjson.js'
import {linePrefixer} from '../../src/report/prefix.js'

function run(chunks: string[]): string {
  let text = ''
  const prefixer = linePrefixer('[a] ', (chunk) => {
    text += chunk
  })
  for (const chunk of chunks) prefixer.write(chunk)
  prefixer.end()
  return text
}

describe('linePrefixer', () => {
  it('labels each line', () => {
    expect(run(['one\ntwo\n'])).toBe('[a] one\n[a] two\n')
  })

  it('holds a line that arrives in pieces until it is whole', () => {
    expect(run(['on', 'e\ntw', 'o\n'])).toBe('[a] one\n[a] two\n')
  })

  it('writes what is left at the end, with a newline', () => {
    expect(run(['one\npartial'])).toBe('[a] one\n[a] partial\n')
  })

  it('writes nothing for no output', () => {
    expect(run([])).toBe('')
  })
})

describe('formatNdjson', () => {
  it('writes one line carrying the schema version', () => {
    const line = formatNdjson({message: 'hello', type: 'notice'})

    expect(line.endsWith('\n')).toBe(true)
    expect(line.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toEqual({message: 'hello', schemaVersion: 1, type: 'notice'})
  })

  it('keeps a message with a newline on one line', () => {
    expect(formatNdjson({message: 'a\nb', type: 'notice'}).trim().split('\n')).toHaveLength(1)
  })
})

describe('formatHuman', () => {
  it.each<[ReportEvent, string | undefined]>([
    [{message: 'careful', type: 'notice'}, 'notice: careful'],
    [{action: 'deploy', type: 'step-started', worker: 'orders'}, 'orders: deploy'],
    [{action: 'deploy', status: 'ok', type: 'step-finished', worker: 'orders'}, 'orders: deploy done'],
    [
      {action: 'deploy', status: 'ok', type: 'step-finished', versionId: 'v1', worker: 'orders'},
      'orders: deploy done, version v1',
    ],
    [{action: 'deploy', message: 'x', status: 'failed', type: 'step-finished', worker: 'orders'}, undefined],
    [{exitCode: 0, status: 'ok', type: 'run-finished'}, undefined],
    [{action: 'deploy', type: 'run-started', workers: []}, undefined],
  ])('%j', (event, line) => {
    expect(formatHuman(event)).toBe(line)
  })

  it('writes lines to the sink it is given', () => {
    const lines: string[] = []

    humanSink((text) => lines.push(text))({message: 'careful', type: 'notice'})

    expect(lines).toEqual(['notice: careful\n'])
  })
})
