import {spawn, type ChildProcess} from 'node:child_process'
import {constants} from 'node:os'

import {MonocfError} from '../errors.js'

const GRACE_MS = 10_000
const SIGNALS: NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM']

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0)
}

/** Without /F, taskkill only asks. Force is for what is still there when the grace period is over. */
export function taskkillArguments(pid: number, signal: NodeJS.Signals): string[] {
  return ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]
}

/** On Windows a kill ends only the process itself, which would leave workerd running under a dead wrangler. */
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', taskkillArguments(child.pid, signal), {shell: false, stdio: 'ignore'}).once('error', () => {
      if (signal === 'SIGKILL') child.kill(signal)
    })
    return
  }

  child.kill(signal)
}

/**
 * The one signal handler. A signal stops new steps and reaches the running children, which get time to finish before
 * the rest are killed. The run then ends by itself through `throwIfInterrupted`, with its cleanup, as 129, 130 or 143.
 */
export class Interrupts {
  /** The signal that ended this run, if any. */
  received?: NodeJS.Signals
  private readonly halted = new AbortController()
  private readonly children = new Set<ChildProcess>()
  private killTimer?: NodeJS.Timeout
  private readonly listeners = new Map<NodeJS.Signals, () => void>()

  constructor() {
    for (const signal of SIGNALS) {
      const listener = () => {
        this.handle(signal)
      }

      this.listeners.set(signal, listener)
      process.on(signal, listener)
    }
  }

  /** Aborted once nothing new should start. */
  get signal(): AbortSignal {
    return this.halted.signal
  }

  /** Stops new steps without a signal from outside. Running steps carry on. */
  halt(): void {
    this.halted.abort()
  }

  /** Removes the handlers once a run is over. */
  dispose(): void {
    for (const [signal, listener] of this.listeners) process.off(signal, listener)
    this.listeners.clear()
    clearTimeout(this.killTimer)
  }

  /** Asks every running child to stop, and kills whatever hasn't after the grace period. */
  stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const child of this.children) terminate(child, signal)
    // Unref'd: the children hold the process open for as long as this has anything left to do.
    this.killTimer ??= setTimeout(() => {
      for (const child of this.children) terminate(child, 'SIGKILL')
    }, GRACE_MS).unref()
  }

  /** Called between steps, so nothing new starts after a signal. */
  throwIfInterrupted(): void {
    if (this.received) throw new MonocfError(`Interrupted by ${this.received}.`, signalExitCode(this.received))
  }

  track(child: ChildProcess): void {
    this.children.add(child)
    child.once('close', () => {
      this.children.delete(child)
    })
    // A signal that arrived while this child was being spawned.
    if (this.received) terminate(child, this.received)
  }

  private handle(signal: NodeJS.Signals): void {
    if (this.received) {
      for (const child of this.children) terminate(child, 'SIGKILL')
      return
    }

    this.received = signal
    this.halt()
    this.stopAll(signal)
  }
}
