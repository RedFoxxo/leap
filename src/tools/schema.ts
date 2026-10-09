import { z } from 'zod'
import { isValidIsoDate } from '../domain/dates.js'

/** Entry ids in openGym are short strings: built-in exercises `0001`, the app's own `<base36 time><random>`. */
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const entryId = z.string().regex(ID, 'must be an id of letters, digits, "-" or "_"')

export const exerciseId = entryId.describe('Exercise id, e.g. "0025" (see read_exercises)')

export const isoDate = z
  .string()
  .refine(isValidIsoDate, 'must be a calendar date YYYY-MM-DD')
  .describe('Date YYYY-MM-DD (the profile’s local calendar day)')

export const limit = (defaultValue: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Maximum items to return (default ${defaultValue}, max ${max}). A capped result says truncated: true.`)

/** A workout's id, or for a workout logged before ids the `YYYY-MM-DD|start` key read_workouts shows for it. */
export const workoutId = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{1,64}|\d{4}-\d{2}-\d{2}\|\d{1,16})$/, 'must be a workout id as read_workouts shows it')
  .describe('Workout id as read_workouts shows it (a workout from before ids: its day and start, "YYYY-MM-DD|<start>")')
