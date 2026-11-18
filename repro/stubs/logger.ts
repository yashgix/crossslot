const show = (value: unknown) =>
  value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value)

/** Everything Sim logged, so the scripts can assert on errors Sim catches itself. */
export const logged: string[] = []

const line = (level: string, message: string, meta: unknown[]) => {
  const text = [message, ...meta.map(show)].join(' ')
  logged.push(text)
  console.log(`    [sim logger.${level}] ${text}`)
}

export const createLogger = (name: string) => ({
  debug: () => {},
  info: () => {},
  warn: (message: string, ...meta: unknown[]) => line('warn', `${name}: ${message}`, meta),
  error: (message: string, ...meta: unknown[]) => line('error', `${name}: ${message}`, meta),
})
