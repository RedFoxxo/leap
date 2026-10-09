import { parseCatalogue, type BuiltinCatalog } from '../../src/catalog/exercises.js'

/** A few records in the shape of leap's data/exercises.json (scripts/build-catalogue.mjs). */
export const CATALOGUE_DATA = {
  source: { project: 'openGym', version: '1.4.0', commit: 'fixture', path: 'catalogue/exercises', licence: 'test' },
  exercises: [
    {
      id: '0025',
      name: 'barbell bench press',
      bodyPart: 'chest',
      equipment: 'barbell',
      target: 'pectorals',
      secondary: ['triceps', 'shoulders'],
      category: 'strength',
      description: 'The classic flat-bench press.',
      steps: ['Lie flat on the bench.', 'Press the bar up.'],
      exercisedb: true,
    },
    { id: '0043', name: 'barbell full squat', bodyPart: 'upper legs', equipment: 'barbell', target: 'glutes', secondary: ['quadriceps', 'hamstrings'], category: 'strength', steps: ['Stand with the bar on your back.'], exercisedb: true },
    { id: '0294', name: 'dumbbell biceps curl', bodyPart: 'upper arms', equipment: 'dumbbell', target: 'biceps', secondary: ['forearms'], category: 'strength', steps: [], exercisedb: true },
    { id: '0739', name: 'sled 45° leg press', bodyPart: 'upper legs', equipment: 'sled machine', target: 'glutes', secondary: ['quadriceps'], category: 'strength', steps: ['Sit in the machine.'], exercisedb: true },
    { id: '0032', name: 'barbell deadlift', bodyPart: 'upper legs', equipment: 'barbell', target: 'glutes', secondary: ['hamstrings', 'lower back'], category: 'strength', steps: ['Stand with your mid-foot under the bar.'], exercisedb: true },
    { id: '12001', name: 'kettlebell test swing', bodyPart: 'full body', equipment: 'kettlebell', target: 'glutes', secondary: ['hamstrings'], category: 'strength', description: 'A made-up exercise in the newer id range.', steps: ['Swing it.'] },
    { id: '12002', name: 'test hamstring stretch', bodyPart: 'upper legs', equipment: 'body weight', target: 'hamstrings', secondary: [], category: 'stretching', steps: [] },
    { id: '', name: 'no id' },
    'not a record',
  ],
  aliases: { '12900': '12001', '12901': 'missing' },
}

export function fixtureCatalog(): BuiltinCatalog {
  return parseCatalogue(structuredClone(CATALOGUE_DATA))
}
