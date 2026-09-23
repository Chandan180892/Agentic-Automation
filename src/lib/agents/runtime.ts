import { AGENTS, isAgentId } from "./registry";
import { memoryPrompt, type AgentDef, type AgentId, type AgentResult, type Memory } from "./types";
import { db } from "@/lib/db";
import { callStructured } from "./llm";

export function agentsAreLive() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export class AgentError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AgentError";
  }
}

/**
 * Invoke one agent. With ANTHROPIC_API_KEY set the model produces the result through a
 * forced tool call, so the output is always shaped like the agent's schema. Without a key
 * the agent's own simulator runs instead, and the result is labelled `simulated` all the
 * way to the UI — the app stays usable before anyone configures a key.
 *
 * `memory` carries the lessons the workspace has learned for this agent. A live model gets them
 * appended to its system prompt; a simulator gets them as an argument.
 */
export async function invokeAgent<T = unknown>(
  agentId: AgentId,
  rawInput: unknown,
  memory?: Memory,
  runId?: string | null
): Promise<AgentResult<T>> {
  const def = AGENTS[agentId] as unknown as AgentDef;
  if (!def) throw new AgentError(`Unknown agent: ${agentId}`);

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new AgentError(
      `Input rejected by ${agentId}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ")}`
    );
  }
  const input = parsed.data;

  if (!agentsAreLive()) {
    return { output: def.output.parse(def.simulate(input, memory)) as T, mode: "simulated", model: "simulator" };
  }

  try {
    const { output, model } = await callStructured<T>({
      agent: agentId,
      system: def.system,
      volatileSystem: memoryPrompt(memory).trim() || undefined,
      prompt: def.prompt(input),
      tool: def.tool,
      toolDescription: def.toolDescription,
      schema: def.output as never,
      maxTokens: def.maxTokens,
      runId,
    });
    return { output, mode: "live", model };
  } catch (err) {
    throw new AgentError(err instanceof Error ? err.message : `${agentId} failed`, err);
  }
}

// --------------------------------------------------------------- persistence

export async function startRun(opts: {
  workspaceId: string;
  sprintId?: string | null;
  storyId?: string | null;
  parentId?: string | null;
  agent: AgentId;
  input: unknown;
}) {
  return db.run.create({
    data: {
      workspaceId: opts.workspaceId,
      sprintId: opts.sprintId ?? null,
      storyId: opts.storyId ?? null,
      parentId: opts.parentId ?? null,
      agent: opts.agent,
      mode: AGENTS[opts.agent].mode,
      status: "running",
      inputJson: JSON.stringify(opts.input),
    },
  });
}

export async function logEvent(
  runId: string,
  message: string,
  level: "info" | "ok" | "warn" | "error" = "info",
  source = "system"
) {
  return db.event.create({ data: { runId, message, level, source, stage: source } });
}

export async function finishRun(
  runId: string,
  status: "succeeded" | "failed" | "needs_review",
  output?: unknown,
  error?: string
) {
  return db.run.update({
    where: { id: runId },
    data: {
      status,
      outputJson: output === undefined ? undefined : JSON.stringify(output),
      error: error ?? null,
      finishedAt: new Date(),
    },
  });
}

/** Runs an agent and records the whole attempt — success or failure — against a Run row. */
export async function runAgentTracked<T = unknown>(opts: {
  workspaceId: string;
  sprintId?: string | null;
  storyId?: string | null;
  /** The autopilot run this belongs to, when it is one step of a cycle. */
  parentId?: string | null;
  agent: string;
  input: unknown;
  memory?: Memory;
}): Promise<{ runId: string; result: AgentResult<T> }> {
  if (!isAgentId(opts.agent)) throw new AgentError(`Unknown agent: ${opts.agent}`);
  const agent = opts.agent;
  const run = await startRun({ ...opts, agent });
  await logEvent(run.id, `${agent} started`, "info", agent);
  if (opts.memory?.lessons.length) {
    await logEvent(run.id, `applying ${opts.memory.lessons.length} learned lesson(s)`, "info", agent);
  }

  try {
    const result = await invokeAgent<T>(agent, opts.input, opts.memory, run.id);
    if (result.mode === "simulated") {
      await logEvent(
        run.id,
        "No ANTHROPIC_API_KEY configured — this result came from the built-in simulator.",
        "warn",
        agent
      );
    }
    await logEvent(run.id, `${agent} finished`, "ok", agent);
    await finishRun(run.id, "succeeded", result.output);
    return { runId: run.id, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", agent);
    await finishRun(run.id, "failed", undefined, msg);
    throw err;
  }
}
