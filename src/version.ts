export const VERSION = '1.0.0'

/**
 * The openGym versions this release works with. leap refuses to write to an
 * older server, and the README's compatibility table states the same range (a
 * test keeps them equal).
 */
export const OPENGYM = {
  /** Oldest openGym version leap writes to. */
  minimum: '1.4.0',
  /** The version the release was verified against (live tests, research). */
  tested: '1.4.0',
} as const
