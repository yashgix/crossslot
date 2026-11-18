export const EXIT = { ok: 0, failed: 1, usage: 2, corpus: 3, docker: 4 } as const

/** An error that ends the process with a specific exit code. */
export class ExitError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export const usage = (message: string) => new ExitError(EXIT.usage, message)
