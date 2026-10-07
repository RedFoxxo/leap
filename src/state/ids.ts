import { randomInt } from 'node:crypto'

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * A new entry id in the app's own format: base-36 milliseconds, then five
 * random base-36 characters. Custom exercises use the prefix `c`.
 */
export function newId(prefix = '', now: number = Date.now()): string {
  let random = ''
  for (let i = 0; i < 5; i++) random += BASE36[randomInt(36)]
  return `${prefix}${now.toString(36)}${random}`
}
