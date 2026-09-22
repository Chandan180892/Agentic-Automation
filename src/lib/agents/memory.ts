import { db } from "@/lib/db";
import type { Memory, RecalledLesson } from "./types";

/**
 * The workspace's learned memory.
 *
 * Learning here is in-context, not fine-tuning: a lesson is a one-sentence rule backed by
 * evidence, injected into the next turn of the agent it is scoped to. What makes it
 * self-correcting is the bookkeeping around it:
 *
 *  - seen again while not applied  → reinforced   (confidence up)
 *  - applied and the problem stayed away → confirmed (confidence up)
 *  - applied and the problem came back anyway → contradicted (confidence down, may retire)
 *
 * Only preventive lessons (heal, coverage) can be contradicted. A known-defect lesson is a
 * record of the world, so seeing the defect again reinforces it rather than disproving it —
 * and once the defect stops reproducing, the lesson is resolved and retires.
 */

export const RECALL_FLOOR = 0.3;
export const RETIRE_BELOW = 0.25;
const NEW_CONFIDENCE = 0.6;
const CEILING = 0.98;
const PREVENTIVE = new Set(["heal", "coverage", "planning"]);

const clamp = (n: number) => Math.round(Math.min(CEILING, Math.max(0, n)) * 100) / 100;

/** Lessons for one agent, strongest first. */
export async function recall(workspaceId: string, scope: string, limit = 10): Promise<Memory> {
  const rows = await db.lesson.findMany({
    where: { workspaceId, scope, status: "active", confidence: { gte: RECALL_FLOOR } },
    orderBy: [{ confidence: "desc" }, { hits: "desc" }],
    take: limit,
  });
  return { lessons: rows.map((r): RecalledLesson => ({ key: r.key, rule: r.rule, confidence: r.confidence })) };
}

export interface LearnedLesson {
  key: string;
  scope: string;
  category: string;
  rule: string;
  evidence: string;
}

export interface LearningOutcome {
  created: string[];
  reinforced: string[];
  confirmed: string[];
  contradicted: string[];
  retired: string[];
  /** Known-defect lessons whose defect no longer reproduces. */
  resolved: string[];
}

/**
 * Applies one cycle's learning.
 *
 * @param applied  keys of the lessons that were injected into this cycle's agents
 * @param learned  what the learner distilled from this cycle's evidence
 * @param hits     how many times each key's underlying problem was observed this cycle
 */
export async function learn(opts: {
  workspaceId: string;
  runId: string;
  applied: string[];
  learned: LearnedLesson[];
  hits: Record<string, number>;
}): Promise<LearningOutcome> {
  const { workspaceId, runId } = opts;
  const outcome: LearningOutcome = { created: [], reinforced: [], confirmed: [], contradicted: [], retired: [], resolved: [] };
  const applied = new Set(opts.applied);
  const seen = new Set(opts.learned.map((l) => l.key));

  for (const l of opts.learned) {
    const hits = Math.max(1, opts.hits[l.key] ?? 1);
    const existing = await db.lesson.findUnique({ where: { workspaceId_key: { workspaceId, key: l.key } } });

    if (!existing) {
      await db.lesson.create({
        data: {
          workspaceId,
          key: l.key,
          scope: l.scope,
          category: l.category,
          rule: l.rule,
          evidence: l.evidence.slice(0, 1000),
          confidence: NEW_CONFIDENCE,
          hits,
          sourceRunId: runId,
        },
      });
      outcome.created.push(l.key);
      continue;
    }

    const contradicted = applied.has(l.key) && PREVENTIVE.has(existing.category);
    const confidence = clamp(existing.confidence + (contradicted ? -0.2 : 0.1));
    const retire = confidence < RETIRE_BELOW;
    await db.lesson.update({
      where: { id: existing.id },
      data: {
        // A retired lesson that the evidence brings back is re-activated, not duplicated.
        status: retire ? "retired" : "active",
        rule: contradicted ? existing.rule : l.rule,
        evidence: l.evidence.slice(0, 1000),
        confidence,
        hits: existing.hits + hits,
        sourceRunId: runId,
      },
    });
    (contradicted ? outcome.contradicted : outcome.reinforced).push(l.key);
    if (retire) outcome.retired.push(l.key);
  }

  // Every applied lesson counts the application; the ones whose problem stayed away are confirmed.
  for (const key of applied) {
    const row = await db.lesson.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (!row) continue;
    const held = !seen.has(key) && PREVENTIVE.has(row.category);
    const resolved = !seen.has(key) && !PREVENTIVE.has(row.category);
    await db.lesson.update({
      where: { id: row.id },
      data: {
        applied: row.applied + 1,
        ...(held ? { confirmed: row.confirmed + 1, confidence: clamp(row.confidence + 0.1) } : {}),
        ...(resolved ? { status: "retired", evidence: "No longer reproduces — the defect appears to be fixed." } : {}),
      },
    });
    if (held) outcome.confirmed.push(key);
    if (resolved) outcome.resolved.push(key);
  }

  return outcome;
}
