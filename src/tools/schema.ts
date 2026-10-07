import { z } from 'zod'

/** Entry ids in openGym are short strings: built-in exercises `0001`, the app's own `<base36 time><random>`. */
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const entryId = z.string().regex(ID, 'must be an id of letters, digits, "-" or "_"')

export const exerciseId = entryId.describe('Exercise id, e.g. "0025" (see read_exercises)')

export const limit = (defaultValue: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Maximum items to return (default ${defaultValue}, max ${max}). A capped result says truncated: true.`)
