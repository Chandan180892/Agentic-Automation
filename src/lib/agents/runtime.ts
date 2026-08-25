import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AGENTS, isAgentId } from "./registry";
import type { AgentDef, AgentId, AgentResult } from "./types";
import { db } from "@/lib/db";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export function agentsAreLive() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Anthropic wants a plain JSON Schema object; zod emits the $schema key it does not use. */
function toolSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
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
 */
export async function invokeAgent<T = unknown>(
  agentId: AgentId,
  rawInput: unknown
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
    return { output: def.output.parse(def.simulate(input)) as T, mode: "simulated", model: "simulator" };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: def.maxTokens ?? 4000,
      system: def.system,
      tools: [
        {
          name: def.tool,
          description: def.toolDescription,
          input_schema: toolSchema(def.output),
        },
      ],
      tool_choice: { type: "tool", name: def.tool },
      messages: [{ role: "user", content: def.prompt(input) }],
    });
  } catch (err) {
    throw new AgentError(
      err instanceof Error ? `${agentId} could not reach the model: ${err.message}` : `${agentId} failed`,
      err
    );
  }

  const block = message.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new AgentError(`${agentId} returned no structured result (stop reason: ${message.stop_reason}).`);
  }

  const out = def.output.safeParse(block.input);
  if (!out.success) {
    throw new AgentError(
      `${agentId} returned a result that did not match its schema: ${out.error.issues
        .map((i) => `${i.path.join(".") || "root"} ${i.message}`)
        .join("; ")}`
    );
  }

  return {
    output: out.data as T,
    mode: "live",
    model: MODEL,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
  };
}

// --------------------------------------------------------------- persistence

export async function startRun(opts: {
  workspaceId: string;
  sprintId?: string | null;
  agent: AgentId;
  input: unknown;
}) {
  return db.run.create({
    data: {
      workspaceId: opts.workspaceId,
      sprintId: opts.sprintId ?? null,
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
  agent: string;
  input: unknown;
}): Promise<{ runId: string; result: AgentResult<T> }> {
  if (!isAgentId(opts.agent)) throw new AgentError(`Unknown agent: ${opts.agent}`);
  const agent = opts.agent;
  const run = await startRun({ ...opts, agent });
  await logEvent(run.id, `${agent} started`, "info", agent);

  try {
    const result = await invokeAgent<T>(agent, opts.input);
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
