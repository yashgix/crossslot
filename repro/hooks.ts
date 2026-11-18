// Resolves only Sim's `@/` path alias and four non-Redis packages. Nothing about Redis is replaced.
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ResolveHook } from 'node:module'

const here = (path: string) => pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href
const SIM = '../data/sim/apps/sim/'
const REALTIME = '../data/sim/apps/realtime/src/'

const STUBS: Record<string, string> = {
  '@sim/logger': './stubs/logger.ts',
  '@sim/utils/errors': './stubs/errors.ts',
  '@sim/realtime-protocol/rooms': './stubs/realtime-protocol.ts',
  '@/lib/core/config/redis': './stubs/redis-config.ts',
  '@/rooms/presence-visibility': './stubs/presence-visibility.ts',
}

export const resolve: ResolveHook = (specifier, context, next) => {
  const stub = STUBS[specifier]
  if (stub) return { url: here(stub), shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const base = context.parentURL?.includes('/apps/realtime/') ? REALTIME : SIM
    return next(here(base + specifier.slice(2) + '.ts'), context)
  }
  return next(specifier, context)
}
