#!/usr/bin/env node
// Builds data/exercises.json, the exercise catalogue leap ships, from a checkout of openGym.
//
//   node scripts/build-catalogue.mjs <path to an openGym checkout>
//
// The checkout must be at a release tag; its commit and version are recorded in the file. Only
// the English text of catalogue/exercises/<id>.json is taken (name, body part, equipment,
// muscles, category, description, steps) plus the alias ids (variantOf). Never the media:
// catalogue/media/ is licensed from Gym visual for openGym only (see NOTICE.md).
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/build-catalogue.mjs <path to an openGym checkout>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
const tag = git('describe', '--tags', '--exact-match', 'HEAD')
if (git('status', '--porcelain', '--', 'catalogue')) throw new Error('the checkout has local changes in catalogue/')

const dir = join(source, 'catalogue', 'exercises')
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const texts = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : [])

const exercises = []
const aliases = {}
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const e = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  if (text(e.variantOf)) {
    aliases[e.id] = e.variantOf
    continue
  }
  const row = { id: e.id, name: e.name, bodyPart: e.bodyPart, equipment: e.equipment, target: e.target, secondary: texts(e.secondaryMuscles) }
  if (text(e.category)) row.category = e.category
  if (text(e.description)) row.description = e.description.trim()
  row.steps = texts(e.instructions)
  if (e.textSource === 'exercisedb') row.exercisedb = true
  for (const k of ['id', 'name', 'bodyPart', 'equipment', 'target']) if (!text(row[k])) throw new Error(`${file}: no ${k}`)
  exercises.push(row)
}

const out = {
  source: { project: 'openGym', version: tag.replace(/^v/, ''), commit, path: 'catalogue/exercises', licence: 'AGPL-3.0-or-later; entries marked exercisedb: MIT (ExerciseDB via hasaneyldrm/exercises-dataset), see NOTICE.md' },
  exercises,
  aliases,
}
writeFileSync(join(root, 'data', 'exercises.json'), JSON.stringify(out) + '\n')
console.log(`data/exercises.json: ${exercises.length} exercises, ${Object.keys(aliases).length} aliases from openGym ${tag} (${commit.slice(0, 8)})`)
