/**
 * Provider-agnostic model client for the agent loop.
 *
 * Two implementations behind one interface:
 *   - AnthropicClient → Claude Opus 4.8 via the Messages API (tool_use loop)
 *   - OpenAIClient    → GPT-5.6 via the Responses API (function calling)
 *
 * pickClient(env, options) selects by which API key is present, so the engine
 * is BYO-model with no lock-in. GPT-5.6 (OpenAI) is the default when both keys
 * are set; an explicit `provider` option or `E2E_PROVE_PROVIDER` env var
 * overrides the choice. The loop (agent/loop.ts) drives both through the same
 * turn-based interface, feeding back tool results and fresh screenshots
 * (vision) each step.
 *
 * Anthropic tool-use shape (Messages API):
 *   POST /v1/messages with { model, max_tokens, system, messages, tools }
 *   response.content = [ {type:"text"|"tool_use", ...} ], stop_reason "tool_use"|"end_turn"
 *   continue by appending the assistant turn, then a user turn of tool_result blocks.
 *
 * OpenAI tool-use shape (Responses API):
 *   POST /v1/responses with { model, instructions, input, tools:[{type:"function",...}] }
 *   response.output = [ {type:"message"} | {type:"function_call", call_id, name, arguments} ]
 *   continue by appending prior output items + function_call_output items.
 */
import type { ToolCall, ToolDescriptor } from "./tools";

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string };

export interface ToolResultInput {
  /** The tool_use_id (Anthropic) / call_id (OpenAI) this result answers. */
  callId: string;
  content: string;
  isError?: boolean;
}

export interface ModelTurn {
  /** Any assistant text emitted this turn. */
  text?: string;
  /** Structured tool calls the model wants executed. */
  toolCalls: ToolCall[];
  /** Why the turn ended: "tool_use" means continue, anything else means stop. */
  stopReason: string;
}

export interface ModelClient {
  readonly name: string;
  /** First turn: system prompt + initial user blocks (goal, diff, screenshot). */
  start(system: string, userBlocks: UserBlock[]): Promise<ModelTurn>;
  /** Subsequent turns: feed back tool results (+ a fresh screenshot if present). */
  continue(toolResults: ToolResultInput[], screenshot?: Buffer): Promise<ModelTurn>;
}

export type ModelProvider = "openai" | "anthropic";

export interface ModelClientOptions {
  tools: ToolDescriptor[];
  maxTokens?: number;
  model?: string;
  /** Force a provider instead of auto-detecting from env. */
  provider?: ModelProvider;
}

const ANTHROPIC_MODEL = "claude-opus-4-8";
const OPENAI_MODEL = "gpt-5.6";

/**
 * Pick a client by which key is present. Defaults to OpenAI (GPT-5.6) when both
 * keys are set. An explicit `options.provider` wins, then `E2E_PROVE_PROVIDER`
 * (openai|anthropic), then the OpenAI-first auto-detect.
 */
export function pickClient(env: NodeJS.ProcessEnv, options: ModelClientOptions): ModelClient {
  const requested = options.provider ?? (typeof env.E2E_PROVE_PROVIDER === "string" ? (env.E2E_PROVE_PROVIDER.toLowerCase() as ModelProvider) : undefined);
  if (requested === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("Provider 'openai' requested but OPENAI_API_KEY is not set.");
    return new OpenAIClient(env.OPENAI_API_KEY, options);
  }
  if (requested === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("Provider 'anthropic' requested but ANTHROPIC_API_KEY is not set.");
    return new AnthropicClient(env.ANTHROPIC_API_KEY, options);
  }
  // Auto-detect: OpenAI first, Anthropic as a fallback.
  if (env.OPENAI_API_KEY) return new OpenAIClient(env.OPENAI_API_KEY, options);
  if (env.ANTHROPIC_API_KEY) return new AnthropicClient(env.ANTHROPIC_API_KEY, options);
  throw new Error(
    "No model API key found. Set OPENAI_API_KEY (GPT-5.6, default) or ANTHROPIC_API_KEY (Claude Opus 4.8).",
  );
}

/* ----------------------------------------------------------------- Anthropic */

class AnthropicClient implements ModelClient {
  readonly name: string;
  private readonly model: string;
  private readonly maxTokens: number;
  // Anthropic conversation: alternating user/assistant turns of content blocks.
  private messages: AnthropicMessage[] = [];

  constructor(private readonly apiKey: string, private readonly options: ModelClientOptions) {
    this.model = options.model ?? ANTHROPIC_MODEL;
    this.maxTokens = options.maxTokens ?? 4_096;
    this.name = `anthropic:${this.model}`;
  }

  async start(system: string, userBlocks: UserBlock[]): Promise<ModelTurn> {
    this.messages = [{ role: "user", content: toAnthropicContent(userBlocks) }];
    return this.call(system);
  }

  async continue(toolResults: ToolResultInput[], screenshot?: Buffer): Promise<ModelTurn> {
    const content: AnthropicContentBlock[] = toolResults.map((result) => ({
      type: "tool_result",
      tool_use_id: result.callId,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    }));
    if (screenshot) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") },
      });
      content.push({ type: "text", text: "Current page screenshot." });
    }
    this.messages.push({ role: "user", content });
    return this.call();
  }

  private async call(system?: string): Promise<ModelTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: this.messages,
      tools: this.options.tools.map(toAnthropicTool),
    };
    if (system) body.system = system;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status}): ${await safeText(response)}`);
    }
    const payload = (await response.json()) as AnthropicResponse;
    // Append the assistant turn verbatim so the next call can continue it. The
    // response content shape is a superset of what we send; cast back to the
    // outbound block union (we only ever append text/tool_use, which round-trip).
    this.messages.push({ role: "assistant", content: payload.content as AnthropicContentBlock[] });

    let text: string | undefined;
    const toolCalls: ToolCall[] = [];
    for (const block of payload.content) {
      if (block.type === "text" && block.text) text = (text ?? "") + block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id ?? `call_${toolCalls.length}`, name: block.name as ToolCall["name"], input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return { text, toolCalls, stopReason: payload.stop_reason };
  }
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
interface AnthropicResponse {
  stop_reason: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}

function toAnthropicContent(blocks: UserBlock[]): AnthropicContentBlock[] {
  return blocks.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } },
  );
}
function toAnthropicTool(tool: ToolDescriptor): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
}

/* -------------------------------------------------------------------- OpenAI */

class OpenAIClient implements ModelClient {
  readonly name: string;
  private readonly model: string;
  // OpenAI Responses API: `input` is an append-only list of items.
  private input: OpenAIInputItem[] = [];

  constructor(private readonly apiKey: string, private readonly options: ModelClientOptions) {
    this.model = options.model ?? OPENAI_MODEL;
    this.name = `openai:${this.model}`;
  }

  async start(system: string, userBlocks: UserBlock[]): Promise<ModelTurn> {
    this.input = [
      // The Responses API takes instructions separately; embed the system there.
      { type: "message", role: "developer", content: [{ type: "input_text", text: system }] },
      { type: "message", role: "user", content: toOpenAIContent(userBlocks) },
    ];
    return this.call();
  }

  async continue(toolResults: ToolResultInput[], screenshot?: Buffer): Promise<ModelTurn> {
    for (const result of toolResults) {
      this.input.push({ type: "function_call_output", call_id: result.callId, output: result.content });
    }
    if (screenshot) {
      this.input.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: dataUrl(screenshot) },
          { type: "input_text", text: "Current page screenshot." },
        ],
      });
    }
    return this.call();
  }

  private async call(): Promise<ModelTurn> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: this.input,
        tools: this.options.tools.map(toOpenAITool),
        tool_choice: "auto",
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${await safeText(response)}`);
    }
    const payload = (await response.json()) as OpenAIResponse;
    // Append the model's output items so the next call can continue the thread.
    // The Responses API echoes assistant items back; we push them as-is (the
    // union below widens to accept the response shape).
    this.input.push(...(payload.output as OpenAIInputItem[]));

    let text: string | undefined;
    const toolCalls: ToolCall[] = [];
    let stopReason = "end";
    for (const item of payload.output) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) text = (text ?? "") + part.text;
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id,
          name: item.name as ToolCall["name"],
          input: parseJsonArguments(item.arguments),
        });
        stopReason = "tool_use";
      }
    }
    return { text, toolCalls, stopReason };
  }
}

type OpenAIInputItem =
  | { type: "message"; role: "user" | "developer" | "assistant"; content: Array<Record<string, unknown>> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };
interface OpenAIResponse {
  output: Array<
    | { type: "message"; role?: string; content?: Array<{ type: string; text?: string }> }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
  >;
  status?: string;
}

function toOpenAIContent(blocks: UserBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) =>
    block.type === "text"
      ? { type: "input_text", text: block.text }
      : { type: "input_image", image_url: dataUrlFromBase64(block.data, block.mediaType) },
  );
}
function toOpenAITool(tool: ToolDescriptor): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  };
}
function dataUrl(buffer: Buffer): string {
  return dataUrlFromBase64(buffer.toString("base64"), "image/png");
}
function dataUrlFromBase64(base64: string, mediaType: string): string {
  return `data:${mediaType};base64,${base64}`;
}
function parseJsonArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 500);
  } catch {
    return "<no body>";
  }
}
