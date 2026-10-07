import { slimDataset, type BuiltinCatalog } from '../../src/catalog/exercises.js'

/** A few records in the upstream dataset's shape (hasaneyldrm/exercises-dataset, MIT). */
export const DATASET_RECORDS = [
  {
    id: '0025',
    name: 'barbell bench press',
    body_part: 'chest',
    equipment: 'barbell',
    target: 'pectorals',
    secondary_muscles: ['triceps', 'shoulders'],
    instruction_steps: { en: ['Lie flat on the bench.', 'Press the bar up.'], de: ['Leg dich hin.'] },
    image: 'images/0025.jpg',
  },
  {
    id: '0043',
    name: 'barbell full squat',
    body_part: 'upper legs',
    equipment: 'barbell',
    target: 'glutes',
    secondary_muscles: ['quadriceps', 'hamstrings'],
    instruction_steps: { en: ['Stand with the bar on your back.'] },
  },
  {
    id: '0294',
    name: 'dumbbell biceps curl',
    body_part: 'upper arms',
    equipment: 'dumbbell',
    target: 'biceps',
    secondary_muscles: ['forearms'],
    instruction_steps: { en: [] },
  },
  {
    id: '0739',
    name: 'sled 45в° leg press',
    body_part: 'upper legs',
    equipment: 'sled machine',
    target: 'glutes',
    secondary_muscles: ['quadriceps'],
    instruction_steps: { en: ['Sit in the machine.'] },
  },
  {
    id: '0032',
    name: 'barbell deadlift',
    body_part: 'upper legs',
    equipment: 'barbell',
    target: 'glutes',
    secondary_muscles: ['hamstrings', 'lower back'],
    instruction_steps: { en: ['Stand with your mid-foot under the bar.'] },
  },
  { id: '', name: 'no id' },
  'not a record',
]

export function fixtureCatalog(): BuiltinCatalog {
  return { exercises: new Map(slimDataset(DATASET_RECORDS).map((e) => [e.id, e])) }
}
