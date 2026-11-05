export interface LinePrefixer {
  /** Writes what's left of an unfinished line. */
  end(): void
  write(text: string): void
}

/** Holds text until a line is complete, so output of parallel processes can't interleave inside a line. */
export function linePrefixer(prefix: string, write: (text: string) => void): LinePrefixer {
  let pending = ''
  return {
    end() {
      if (pending !== '') write(`${prefix}${pending}\n`)
      pending = ''
    },
    write(text) {
      const lines = (pending + text).split('\n')
      pending = lines.pop()!
      for (const line of lines) write(`${prefix}${line}\n`)
    },
  }
}
