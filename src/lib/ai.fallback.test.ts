import { beforeEach, describe, expect, it, vi } from "vitest";

const aiChat = vi.fn();
const warning = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { aiChat: (...args: unknown[]) => aiChat(...args) },
  writeGuard: { engine: () => "mongo" },
}));
vi.mock("sonner", () => ({ toast: { warning: (...args: unknown[]) => warning(...args) } }));

const { isModelUnavailable, summarizeResults } = await import("./ai");
const { useAi, DEFAULT_MODEL, MODEL_ID_RE } = await import("@/stores/ai");

describe("MODEL_ID_RE", () => {
  it("accepts real OpenRouter ids", () => {
    for (const id of ["anthropic/claude-sonnet-5", "openai/gpt-5.1", "meta-llama/llama-3.3-70b-instruct:free", "google/gemini-2.5-pro", "~anthropic/claude-sonnet-latest", "x-ai/grok-4"]) {
      expect(MODEL_ID_RE.test(id), id).toBe(true);
    }
  });
  it("rejects pasted junk", () => {
    for (const id of ["claude-sonnet-5", "https://openrouter.ai/anthropic/claude", "anthropic/ claude", "/gpt", "vendor/model/extra"]) {
      expect(MODEL_ID_RE.test(id), id).toBe(false);
    }
  });
});

const reply = (content: string) => ({
  content,
  model: "x",
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cost: null,
});

describe("isModelUnavailable", () => {
  it("matches OpenRouter's unknown / retired model errors", () => {
    expect(isModelUnavailable(new Error("OpenRouter (400 Bad Request): acme/nope is not a valid model ID"))).toBe(true);
    expect(isModelUnavailable(new Error("OpenRouter (404 Not Found): No endpoints found for acme/old."))).toBe(true);
    expect(isModelUnavailable(new Error("OpenRouter: model acme/x does not exist"))).toBe(true);
  });
  it("ignores unrelated failures", () => {
    expect(isModelUnavailable(new Error("OpenRouter (401 Unauthorized): Invalid key - check the API key"))).toBe(false);
    expect(isModelUnavailable(new Error("OpenRouter (429 Too Many Requests): slow down"))).toBe(false);
  });
});

describe("chat model fallback", () => {
  beforeEach(() => {
    aiChat.mockReset();
    warning.mockReset();
    useAi.setState({ configured: true, mode: "normal", model: "acme/typo-model" });
  });

  it("retries once on openrouter/auto when the saved model is unknown", async () => {
    aiChat
      .mockRejectedValueOnce("OpenRouter (400 Bad Request): acme/typo-model is not a valid model ID")
      .mockResolvedValueOnce(reply("summary"));
    const out = await summarizeResults("q", []);
    expect(out.summary).toBe("summary");
    expect(aiChat.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual(["acme/typo-model", DEFAULT_MODEL]);
    expect(warning).toHaveBeenCalledTimes(1);
    // The saved choice is left alone - the user decides what to change.
    expect(useAi.getState().model).toBe("acme/typo-model");
  });

  it("does not retry other errors", async () => {
    aiChat.mockRejectedValueOnce("OpenRouter (402 Payment Required): add credits");
    await expect(summarizeResults("q", [])).rejects.toBeDefined();
    expect(aiChat).toHaveBeenCalledTimes(1);
  });

  it("does not loop when auto itself fails", async () => {
    useAi.setState({ model: DEFAULT_MODEL });
    aiChat.mockRejectedValueOnce("OpenRouter (404 Not Found): No endpoints found matching your data policy");
    await expect(summarizeResults("q", [])).rejects.toBeDefined();
    expect(aiChat).toHaveBeenCalledTimes(1);
  });
});
