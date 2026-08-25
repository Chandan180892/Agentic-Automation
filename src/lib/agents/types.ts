import type { z } from "zod";

export type AgentId =
  | "sprint-planner"
  | "qe-pipeline"
  | "qe-auto-heal"
  | "batch-heal"
  | "qe-insights";

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
  simulate: (input: z.infer<I>) => z.infer<O>;
  maxTokens?: number;
}

export interface AgentResult<T = unknown> {
  output: T;
  mode: "live" | "simulated";
  model: string;
  usage?: { input: number; output: number };
}
