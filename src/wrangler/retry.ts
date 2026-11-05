import {setTimeout as wait} from 'node:timers/promises'

import type {WranglerResult} from './process.js'
import {isSuccessful, type WranglerCall} from './read.js'

export const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 2000

// 10429 is the Cloudflare API's own rate limit, which R2 gives with "Rate limited".
const TRANSIENT =
  /fetch failed|too many requests|rate limited|\b(?:status|code|http)\b[ :=]*(?:10429|429|5\d\d)\b|internal server error|bad gateway|service unavailable|gateway time-?out/i

/** What can pass by itself: a request that never got an answer, a rate limit, and a 5xx. */
export function isTransient(result: WranglerResult): boolean {
  if (isSuccessful(result) || result.signal) return false
  const {code, message = ''} = result.output.failure ?? {}
  if (code === 429 || code === 10_429 || (code !== undefined && code >= 500 && code < 600)) return true
  return TRANSIENT.test(`${message}\n${result.stderr}`)
}

/** Exponential, and between half and all of it, so that parallel workers don't come back together. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + random() / 2)
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await wait(ms, undefined, {signal})
  } catch {
    // Aborted: the caller checks the signal next.
  }
}

/** Reads get the policy writes get. An outage in a read would otherwise fail a whole run. */
export function withReadRetries(call: WranglerCall, signal?: AbortSignal): WranglerCall {
  return async (step, accountId) => {
    for (let attempt = 1; ; attempt++) {
      const result = await call(step, accountId)
      if (attempt >= MAX_ATTEMPTS || signal?.aborted || !isTransient(result)) return result
      await pause(retryDelayMs(attempt), signal)
    }
  }
}
