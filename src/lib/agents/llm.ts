import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * The one place Gantry calls the model. Every agent and sub-agent goes through `callStructured`,
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
}

export async function callStructured<T>(call: StructuredCall<T>): Promise<{ output: T; model: string }> {
  const cfg = env();
  const model = cfg.ANTHROPIC_MODEL;

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
  log.info("model call", {
    agent: call.agent,
    model,
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
