import type { z } from "zod";
import { db } from "@/lib/db";
import type * as S from "./schemas";

type PlannerOut = z.infer<typeof S.SprintPlannerOut>;

/** Applies a sprint-planner result: sizes, order, commitment, and any drafted acceptance criteria. */
export async function applySprintPlan(
  stories: { id: string; key: string }[],
  plan: PlannerOut
): Promise<void> {
  const drafted = new Map(plan.draftedAcceptanceCriteria.map((d) => [d.key, d.criteria]));
  await Promise.all(
    plan.commitment.map((c) => {
      const story = stories.find((s) => s.key === c.key);
      if (!story) return Promise.resolve(null);
      const draft = drafted.get(c.key);
      return db.story.update({
        where: { id: story.id },
        data: {
          points: c.points,
          priority: c.order,
          committed: c.committed,
          ...(draft?.length
            ? {
                acceptanceCriteria: JSON.stringify(draft),
                tagsJson: JSON.stringify(["ac-drafted-by-agent"]),
              }
            : {}),
        },
      });
    })
  );
}
