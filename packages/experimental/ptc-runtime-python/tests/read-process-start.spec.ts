/** Portable fixtures for Linux process identity reads. */
import { describe, expect, it, vi } from 'vitest'
import { readProcessStart } from '../src/index.ts'

const { readStat } = vi.hoisted(() => ({
  readStat: vi.fn<(path: string, encoding: unknown) => string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (args[0] === '/proc/4242/stat') return readStat(args[0], args[1])
      return actual.readFileSync(...args)
    },
  }
})

/** Keep process-global platform replacement within a synchronous assertion. */
function onLinux(assertion: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor) throw new Error('process.platform must have an own descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    assertion()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    readStat.mockReset()
  }
  expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(descriptor)
}

describe('readProcessStart — portable Linux fixtures', () => {
  it('selects starttime after a command name containing spaces and a closing parenthesis', () => {
    onLinux(() => {
      // Fields 4–21 precede starttime; distinct neighbors expose an off-by-one.
      readStat.mockReturnValue('4242 (worker ) with spaces) S 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 987654 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52\n')
      expect(readProcessStart(4242)).toBe('987654')
      expect(readStat).toHaveBeenCalledExactlyOnceWith('/proc/4242/stat', 'utf8')
    })
  })

  it('returns undefined when the process stat file has disappeared', () => {
    onLinux(() => {
      readStat.mockImplementation(() => {
        throw Object.assign(new Error('process stat file disappeared'), { code: 'ENOENT' })
      })
      expect(readProcessStart(4242)).toBeUndefined()
      expect(readStat).toHaveBeenCalledExactlyOnceWith('/proc/4242/stat', 'utf8')
    })
  })
})
