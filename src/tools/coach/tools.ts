import { z } from 'zod'
import type { ExerciseIndex } from '../../catalog/exercises.js'
import { routineName } from '../../domain/plan.js'
import type { Err } from '../../http/result.js'
import { isRecord, type State } from '../../state/types.js'
import { loadProfile, type ToolContext } from '../context.js'
import { failure, invalid, success } from '../respond.js'
import { entryId } from '../schema.js'
import { defineTool } from '../types.js'

/**
 * openGym's AI Coach runs on the server; leap asks it for plans, reviews and
 * debriefs and records decisions. Applying a proposal is done with leap's own
 * write tools (decided with the user): the app applies changes by editing the
 * profile itself, and those edits are exactly what the write tools already do.
 */

const lang = z.string().regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/).optional().describe("Language the Coach writes in; default the profile's")

function coachFailure(summary: string, e: Err) {
  if (e.status === 503) return failure('The AI Coach is not set up on this instance (an admin switches it on and connects a provider)', e)
  const reasons: Record<string, string> = {
    consent: 'The Coach needs consent first: open the Coach in the openGym app and agree there. leap does not give consent on your behalf.',
    busy: 'The Coach is already working on a job for this profile; check read_coach in a moment.',
    cap: "Today's Coach limit is used up (this profile's or the instance's).",
    shared: "In this instance's setup the provider account belongs to another profile.",
    unprivileged: 'The server cannot run Coach jobs safely (no unprivileged user); an admin has to fix the setup.',
  }
  return failure(e.code && Object.hasOwn(reasons, e.code) ? reasons[e.code]! : summary, e)
}

/** Exercise and routine names next to the ids a proposal carries, so it can be read and applied. */
function annotate(pending: unknown, state: State | null, exercises: ExerciseIndex): unknown {
  if (!isRecord(pending)) return pending
  const out = structuredClone(pending)
  if (Array.isArray(out.changes)) {
    for (const c of out.changes.filter(isRecord)) {
      const target = isRecord(c.target) ? c.target : undefined
      if (typeof target?.exId === 'string') target.exerciseName = exercises.name(target.exId)
      if (typeof target?.routineId === 'string' && !c.routineName) target.routineName = routineName(state, target.routineId)
      for (const k of ['before', 'after'] as const) {
        const v = c[k]
        if (isRecord(v) && typeof v.id === 'string' && !v.name) v.name = exercises.name(v.id)
      }
    }
  }
  if (isRecord(out.bundle) && Array.isArray(out.bundle.routines)) {
    const custom = new Map((Array.isArray(out.bundle.customEx) ? out.bundle.customEx : []).filter(isRecord).map((c) => [c.id, c.n]))
    for (const r of out.bundle.routines.filter(isRecord)) {
      for (const e of (Array.isArray(r.ex) ? r.ex : []).filter(isRecord)) {
        if (typeof e.id === 'string') e.name = typeof custom.get(e.id) === 'string' ? custom.get(e.id) : exercises.name(e.id)
      }
    }
  }
  return out
}

const HOW_TO_APPLY = {
  review: 'Apply each accepted change with leap\'s write tools: for a routine change, read_routine, change that field of that exercise, and write the exercises back with write_routine (fields left as they were stay as they are); write_week_plan for the week. Then call write_coach_resolve with the accepted and rejected change ids.',
  create: 'To take the plan: create its routines with write_routine (and custom exercises with write_custom_exercise first), set the week with write_week_plan using the new routine ids, then write_coach_resolve with accepted: ["plan"]. To drop it: write_coach_resolve with dismissed: true.',
  debrief: 'A debrief changes nothing; mark it read with write_coach_resolve accepted: ["debrief"].',
}

async function status(ctx: ToolContext) {
  return ctx.http.request<{ job: unknown; pending: unknown; cap: unknown; last: unknown; maxMessageLen?: number }>({ method: 'GET', path: '/api/coach/status' })
}

export const readCoach = defineTool({
  name: 'read_coach',
  description:
    'The AI Coach: whether it is on and which provider and account it uses, the job running now, the proposal waiting for a decision (a review\'s change-set, a plan bundle or a session debrief, with exercise and routine names added), today\'s usage and how the last job ended, plus how to apply the proposal with leap\'s tools.',
  input: {},
  async handler(_args, ctx) {
    const [s, account, profile] = await Promise.all([
      status(ctx),
      ctx.http.request<Record<string, unknown>>({ method: 'GET', path: '/api/coach/account' }),
      loadProfile(ctx),
    ])
    if (!s.ok) return coachFailure('Could not read the Coach', s)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const pending = annotate(s.data.pending, profile.data.state, profile.data.exercises)
    const kind = isRecord(pending) && typeof pending.kind === 'string' ? (pending.kind as keyof typeof HOW_TO_APPLY) : undefined
    const consent = isRecord(profile.data.state?.coach) && isRecord(profile.data.state.coach.consent) ? Boolean(profile.data.state.coach.consent.agreedAt) : false
    return success({
      consent,
      ...(account.ok ? { account: account.data } : {}),
      job: s.data.job,
      pending,
      ...(kind && HOW_TO_APPLY[kind] ? { howToApply: HOW_TO_APPLY[kind] } : {}),
      cap: s.data.cap,
      last: s.data.last,
      maxMessageLen: s.data.maxMessageLen,
    })
  },
})

const intake = z
  .object({
    goal: z.string().max(40).optional().describe('e.g. muscle, strength, fat-loss'),
    experience: z.string().max(40).optional().describe('e.g. novice, intermediate, advanced'),
    daysPerWeek: z.number().int().min(1).max(7).optional(),
    preferredDays: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('0 = Sunday'),
    sessionMin: z.number().int().min(10).max(300).optional(),
    equipment: z.array(z.string().max(40)).max(30).optional(),
    limitations: z.string().max(1000).optional().describe('Injuries and anything to work around'),
  })
  .strict()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const writeCoachRequest = defineTool({
  name: 'write_coach_request',
  description:
    'Ask the AI Coach for something; this spends the instance\'s provider budget (one job per call, one at a time). kind "plan": a new training plan from `intake`, or `refine` (plain words) to rework the plan waiting now. kind "review": a review of the training since the last one, with an optional `note`. kind "debrief": a read of one workout (`workoutId`, default the latest). Waits up to `waitSec` (default 60) for the answer; otherwise check read_coach later.',
  input: {
    kind: z.enum(['plan', 'review', 'debrief']),
    intake: intake.optional(),
    refine: z.string().min(1).max(4000).optional(),
    note: z.string().max(4000).optional(),
    workoutId: entryId.optional(),
    lang,
    waitSec: z.number().int().min(0).max(300).optional(),
  },
  async handler(args, ctx) {
    if (args.kind !== 'plan' && (args.intake || args.refine)) return invalid('intake and refine belong to kind "plan"')
    if (args.kind !== 'review' && args.note !== undefined) return invalid('note belongs to kind "review"')
    if (args.kind !== 'debrief' && args.workoutId) return invalid('workoutId belongs to kind "debrief"')
    if (args.intake && args.refine) return invalid('give intake for a new plan or refine for the waiting one, not both')
    const body: Record<string, unknown> = {}
    if (args.intake) body.intake = args.intake
    if (args.refine) body.refine = args.refine
    if (args.note) body.note = args.note
    if (args.workoutId) body.workoutId = args.workoutId
    if (args.lang) body.lang = args.lang
    const queued = await ctx.http.request<{ job: { id: string } }>({ method: 'POST', path: `/api/coach/${args.kind}`, json: body })
    if (!queued.ok) return coachFailure('The Coach did not take the job', queued)
    const id = isRecord(queued.data) && isRecord(queued.data.job) && typeof queued.data.job.id === 'string' ? queued.data.job.id : undefined
    if (!id) return failure('The Coach answered without a job id; check read_coach to see whether it is working')
    const deadline = Date.now() + (args.waitSec ?? 60) * 1000
    while (Date.now() < deadline) {
      await sleep(1500)
      const s = await status(ctx)
      if (!s.ok) return coachFailure('The job was queued, but reading its outcome failed', s)
      const job = isRecord(s.data.job) ? s.data.job : null
      if (job?.id === id) continue
      const last = isRecord(s.data.last) ? s.data.last : null
      const profile = await loadProfile(ctx)
      const pending = profile.ok ? annotate(s.data.pending, profile.data.state, profile.data.exercises) : s.data.pending
      const done = isRecord(pending) && pending.id === id
      const kind = done && typeof pending.kind === 'string' ? (pending.kind as keyof typeof HOW_TO_APPLY) : undefined
      return success({
        job: id,
        outcome: last?.id === id ? last.outcome : done ? 'ready' : 'unknown',
        ...(last?.id === id && last.errorClass ? { errorClass: last.errorClass } : {}),
        ...(last?.id === id && last.reading ? { reading: last.reading } : {}),
        ...(done ? { proposal: pending } : {}),
        ...(kind ? { howToApply: HOW_TO_APPLY[kind] } : {}),
      })
    }
    return success({ job: id, outcome: 'running', note: 'The Coach is still working; check read_coach in a while.' })
  },
})

export const writeCoachResolve = defineTool({
  name: 'write_coach_resolve',
  description:
    'Record the decision on the waiting Coach proposal and clear it. This does not change the plan: apply what was accepted with leap\'s write tools first (see howToApply in read_coach). A review: accepted and rejected change ids. A plan: accepted ["plan"]. A debrief: accepted ["debrief"]. Or dismissed: true to throw it away.',
  input: {
    accepted: z.array(z.string().min(1).max(40)).max(100).optional(),
    rejected: z.array(z.string().min(1).max(40)).max(100).optional(),
    dismissed: z.boolean().optional(),
  },
  async handler(args, ctx) {
    if (!args.dismissed && !args.accepted?.length && !args.rejected?.length) return invalid('give accepted/rejected ids, or dismissed: true')
    if (args.dismissed && (args.accepted?.length || args.rejected?.length)) return invalid('a dismissed proposal has no accepted or rejected changes')
    const s = await status(ctx)
    if (!s.ok) return coachFailure('Could not read the Coach', s)
    if (!isRecord(s.data.pending)) return invalid('no proposal is waiting')
    const pending = s.data.pending
    const known = new Set(
      pending.kind === 'review' && Array.isArray(pending.changes) ? pending.changes.filter(isRecord).map((c) => String(c.id)) : pending.kind === 'create' ? ['plan'] : ['debrief'],
    )
    const unknown = [...(args.accepted ?? []), ...(args.rejected ?? [])].filter((id) => !known.has(id))
    if (unknown.length) return invalid(`not in the waiting proposal: ${unknown.join(', ')} (it has ${[...known].join(', ')})`)
    const body = args.dismissed ? { dismissed: true } : { ...(args.accepted ? { accepted: args.accepted } : {}), ...(args.rejected ? { rejected: args.rejected } : {}) }
    const r = await ctx.http.request({ method: 'POST', path: '/api/coach/pending/resolve', json: body })
    if (!r.ok) return coachFailure('Could not record the decision', r)
    return success({ resolved: pending.id, kind: pending.kind, ...body })
  },
})

export const readCoachCohort = defineTool({
  name: 'read_coach_cohort',
  description:
    'How this profile compares with others on the instance who opted in (medians only, at least three people): sessions per week and lifts, in the profile unit. Says why when there is nothing to show.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/coach/cohort' })
    if (!r.ok) return coachFailure('Could not read the comparison', r)
    return success(r.data)
  },
})

export const writeCoachShare = defineTool({
  name: 'write_coach_share',
  description: "Opt this profile in or out of the Coach's comparison with others on the instance (its numbers then count towards the medians others see).",
  input: { share: z.boolean() },
  async handler(args, ctx) {
    const r = await ctx.http.request<{ sharing: boolean }>({ method: 'POST', path: '/api/coach/cohort/share', json: { share: args.share } })
    if (!r.ok) return coachFailure('Could not change sharing', r)
    return success({ sharing: r.data.sharing })
  },
})

export const deleteCoachData = defineTool({
  name: 'delete_coach_data',
  description:
    "Make the server forget everything the Coach holds for this profile: the job, the waiting proposal, its history and the sharing flag. Today's usage count stays. Consent itself is kept in the profile and is withdrawn in the app.",
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/coach/forget', json: {} })
    if (!r.ok) return failure('Could not clear the Coach data', r)
    return success({ forgotten: true })
  },
})

export const coachReadTools = [readCoach, readCoachCohort]
export const coachWriteTools = [writeCoachRequest, writeCoachResolve, writeCoachShare]
export const coachDeleteTools = [deleteCoachData]
