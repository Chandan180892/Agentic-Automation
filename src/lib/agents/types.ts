import type { z } from "zod";

export type AgentId =
  | "sprint-planner"
  | "qe-pipeline"
  | "qe-auto-heal"
  | "batch-heal"
  | "qe-insights"
  | "requirements-reviewer"
  | "cycle-reporter"
  | "learner";

export type AgentMode = "single" | "batch";

export interface AgentDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: AgentId;
  name: string;
  role: string;
  /** One paragraph, written for the person choosing an agent — not for the model. */
  description: string;
  io: [string, string];
  mode: AgentMode;
  input: I;
  output: O;
  system: string;
  /** Name of the structured-output tool the model must call. */
  tool: string;
  toolDescription: string;
  prompt: (input: z.infer<I>) => string;
  /** Deterministic stand-in used when no ANTHROPIC_API_KEY is configured. */
  simulate: (input: z.infer<I>, memory?: Memory) => z.infer<O>;
  maxTokens?: number;
}

export interface AgentResult<T = unknown> {
  output: T;
  mode: "live" | "simulated";
  model: string;
  usage?: { input: number; output: number };
}

/** A lesson as an agent sees it: the rule, and the key the simulators match on. */
export interface RecalledLesson {
  key: string;
  rule: string;
  confidence: number;
}

/** What the workspace has learned that applies to one agent, injected into its turn. */
export interface Memory {
  lessons: RecalledLesson[];
}

export const hasLesson = (memory: Memory | undefined, key: string) =>
  Boolean(memory?.lessons.some((l) => l.key === key));

/** Appended to an agent's system prompt so a live model applies what the workspace learned. */
export function memoryPrompt(memory: Memory | undefined) {
  if (!memory?.lessons.length) return "";
  return [
    "",
    "",
    "Lessons this workspace has learned from earlier runs. Each one came from verified evidence",
    "(a failed execution, a verifier defect, a heal). Apply them unless the input clearly makes",
    "one inapplicable:",
    ...memory.lessons.map((l) => `- ${l.rule} (confidence ${l.confidence.toFixed(2)})`),
  ].join("\n");
}
