import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * The one place Autopilot calls the model. Every agent and sub-agent goes through `callStructured`,
 * which gives them the same guarantees:
 *
 * - the result is a schema-valid object or an error that says why — never a half-parsed guess;
 * - timeouts and retries on 408/409/429/5xx and dropped connections (the SDK's own retry loop);
 * - refusals and truncated output are reported as what they are;
 * - the stable system prompt is cached, and learned lessons go after the cache breakpoint so a
 *   new lesson does not invalidate it;
 * - token usage is recorded against the run, and a per-workspace daily budget is enforced before
 *   the call is made.
 */

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: "refusal" | "truncated" | "no-result" | "invalid" | "budget" | "api",
    readonly retryable = false
  ) {
    super(message);
    this.name = "ModelError";
  }
}

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic({
    apiKey: env().ANTHROPIC_API_KEY,
    timeout: env().MODEL_TIMEOUT_MS,
    maxRetries: env().MODEL_MAX_RETRIES,
  });
  return client;
}

/**
 * Models that reject a forced `tool_choice` with a 400. For them the tool is offered with
 * `tool_choice: auto`, marked strict, and the prompt names it; a reply without the tool call is
 * then reported as "no-result" rather than silently accepted.
 */
const NO_FORCED_TOOL = [/^claude-opus-5-5/, /^claude-fable-5-1/, /^claude-mythos-5-1/];
export const supportsForcedTool = (model: string) => !NO_FORCED_TOOL.some((re) => re.test(model));

function toolSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

/**
 * List prices in dollars per million tokens (Claude API, first party). Cache writes (5-minute
 * TTL) cost 1.25× input and cache reads 0.1× input. A model not listed is not priced — its
 * calls are still counted in tokens.
 */
const PRICES: [RegExp, number, number][] = [
  [/^claude-(fable|mythos)-5/, 10, 50],
  [/^claude-opus-5-5/, 4, 20],
  [/^claude-opus-(5|4-[5-8])/, 5, 25],
  [/^claude-sonnet-5/, 2, 10],
  [/^claude-sonnet-4/, 3, 15],
  [/^claude-haiku-4/, 1, 5],
];

/** Dollar cost of one call's usage, or null when the model has no known price. */
export function costUsd(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
): number | null {
  const p = PRICES.find(([re]) => re.test(model));
  if (!p) return null;
  const [, inp, out] = p;
  return (
    (u.input_tokens * inp +
      (u.cache_creation_input_tokens ?? 0) * inp * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inp * 0.1 +
      u.output_tokens * out) /
    1_000_000
  );
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Models that take `output_config.effort`; Haiku 4.5 and older reject it. */
const EFFORT_MODELS = /^claude-(opus-(5|4-[5-8])|sonnet-(5|4-6)|fable|mythos)/;
export const supportsEffort = (model: string) => EFFORT_MODELS.test(model);

/** The model a stage runs on: the fast model for light stages when one is configured. */
export function modelFor(tier: "main" | "fast" = "main") {
  const cfg = env();
  return tier === "fast" && cfg.ANTHROPIC_FAST_MODEL ? cfg.ANTHROPIC_FAST_MODEL : cfg.ANTHROPIC_MODEL;
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ");

/** Tokens used by the workspace since UTC midnight. */
export async function tokensUsedToday(workspaceId: string) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const agg = await db.run.aggregate({
    where: { workspaceId, startedAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
}

export interface StructuredCall<T> {
  /** Name for logs and errors, e.g. "spec-author". */
  agent: string;
  system: string;
  /** Appended after the cached system prompt; changes per cycle (learned lessons). */
  volatileSystem?: string;
  prompt: string;
  tool: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** The run to charge usage to, and whose workspace budget applies. */
  runId?: string | null;
  /**
   * How hard the model should think. Reading and routing stages run low; writing code and the
   * final review run high. Ignored by models that do not support it.
   */
  effort?: Effort;
  /** "fast" runs on ANTHROPIC_FAST_MODEL when one is set. */
  tier?: "main" | "fast";
}

export async function callStructured<T>(call: StructuredCall<T>): Promise<{ output: T; model: string }> {
  const cfg = env();
  const model = modelFor(call.tier);

  let workspaceId: string | null = null;
  if (call.runId) {
    const run = await db.run.findUnique({ where: { id: call.runId }, select: { workspaceId: true } });
    workspaceId = run?.workspaceId ?? null;
  }
  if (workspaceId && cfg.AGENT_DAILY_TOKEN_BUDGET > 0) {
    const used = await tokensUsedToday(workspaceId);
    if (used >= cfg.AGENT_DAILY_TOKEN_BUDGET) {
      throw new ModelError(
        `The workspace has used ${used.toLocaleString("en")} of its ${cfg.AGENT_DAILY_TOKEN_BUDGET.toLocaleString("en")} daily model tokens. It resets at 00:00 UTC; raise AGENT_DAILY_TOKEN_BUDGET to allow more.`,
        "budget"
      );
    }
  }

  const forced = supportsForcedTool(model);
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }];
  if (call.volatileSystem) system.push({ type: "text", text: call.volatileSystem });
  if (!forced) {
    system.push({ type: "text", text: `Respond only by calling the ${call.tool} tool, exactly once.` });
  }

  const started = Date.now();
  let message: Anthropic.Message;
  try {
    message = await anthropic().messages.create({
      model,
      max_tokens: call.maxTokens ?? 8000,
      system,
      tools: [
        {
          name: call.tool,
          description: call.toolDescription,
          input_schema: toolSchema(call.schema),
          ...(forced ? {} : { strict: true }),
        },
      ],
      tool_choice: forced ? { type: "tool", name: call.tool } : { type: "auto" },
      ...(call.effort && supportsEffort(model) ? { output_config: { effort: call.effort } } : {}),
      messages: [{ role: "user", content: call.prompt }],
    });
  } catch (err) {
    const retryable =
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.APIConnectionError ||
      (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500);
    const reason =
      err instanceof Anthropic.AuthenticationError
        ? "the API key was rejected"
        : err instanceof Anthropic.RateLimitError
          ? "rate limited after retries"
          : err instanceof Anthropic.BadRequestError
            ? `the request was rejected (${err.message})`
            : err instanceof Error
              ? err.message
              : String(err);
    log.warn("model call failed", { agent: call.agent, model, reason, retryable });
    throw new ModelError(`${call.agent} could not reach the model: ${reason}`, "api", retryable);
  }

  const usage = message.usage;
  const cost = costUsd(model, usage);
  log.info("model call", {
    agent: call.agent,
    model,
    effort: call.effort,
    usd: cost === null ? undefined : Number(cost.toFixed(5)),
    ms: Date.now() - started,
    stop: message.stop_reason,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  });
  if (call.runId) {
    await db.run
      .update({
        where: { id: call.runId },
        data: {
          modelCalls: { increment: 1 },
          inputTokens: { increment: usage.input_tokens },
          outputTokens: { increment: usage.output_tokens },
          cacheReadTokens: { increment: usage.cache_read_input_tokens ?? 0 },
          cacheWriteTokens: { increment: usage.cache_creation_input_tokens ?? 0 },
          costMicroUsd: { increment: cost === null ? 0 : Math.round(cost * 1_000_000) },
        },
      })
      .catch(() => {
        /* usage accounting must never fail the agent */
      });
  }

  if (message.stop_reason === "refusal") {
    throw new ModelError(`${call.agent}: the model declined this request.`, "refusal");
  }
  const block = message.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === call.tool);
  if (!block) {
    throw new ModelError(
      message.stop_reason === "max_tokens"
        ? `${call.agent}: the answer was cut off at ${call.maxTokens ?? 8000} tokens before it was complete.`
        : `${call.agent} returned no structured result (stop reason: ${message.stop_reason}).`,
      message.stop_reason === "max_tokens" ? "truncated" : "no-result"
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new ModelError(`${call.agent}: the answer was cut off before it was complete.`, "truncated");
  }
  const parsed = call.schema.safeParse(block.input);
  if (!parsed.success) {
    throw new ModelError(`${call.agent} returned a result that did not match its schema: ${issues(parsed.error)}`, "invalid");
  }
  return { output: parsed.data, model };
}
