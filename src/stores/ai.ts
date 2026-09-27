import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, type AiModel } from "@/lib/api";

/** "normal" answers fast; "deep" asks the model for high reasoning effort. */
export type AiMode = "normal" | "deep";

/** OpenRouter's auto router picks a capable model per request. */
export const DEFAULT_MODEL = "openrouter/auto";

/** OpenRouter model ids: `vendor/model`, optionally `:variant` (`:free`,
 *  `:online`) and a leading `~` for OpenRouter's moving aliases. */
export const MODEL_ID_RE = /^~?[a-z0-9][\w.-]*\/[\w.~-]+(:[\w.-]+)?$/i;

export const AI_MODE_META: Record<AiMode, { label: string; hint: string }> = {
  normal: { label: "Normal", hint: "fast, light reasoning - lookups, counts, simple groupings" },
  deep: { label: "Deep think", hint: "slower, reasons first - joins, multi-stage pipelines, vague questions" },
};

interface AiState {
  model: string;
  mode: AiMode;
  /** Send one sample document per collection and result rows to the model.
   *  Off = only collection and field names leave the machine. */
  shareSamples: boolean;
  /** Backend truth: an OpenRouter key is stored. Never the key itself. */
  configured: boolean;
  /** Cached OpenRouter model list for the picker (not persisted). */
  models: AiModel[] | null;

  setModel: (model: string) => void;
  setMode: (mode: AiMode) => void;
  setShareSamples: (on: boolean) => void;
  refresh: () => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  loadModels: (force?: boolean) => Promise<AiModel[]>;
}

export const useAi = create<AiState>()(
  persist(
    (set, get) => ({
      model: DEFAULT_MODEL,
      mode: "normal",
      shareSamples: true,
      configured: false,
      models: null,
      setModel: (model) => set({ model: model.trim() || DEFAULT_MODEL }),
      setMode: (mode) => set({ mode }),
      setShareSamples: (on) => set({ shareSamples: on }),
      refresh: async () => {
        try {
          set({ configured: (await api.aiStatus()).configured });
        } catch {
          // Backend unavailable: keep the last known state.
        }
      },
      saveKey: async (key) => {
        set({ configured: (await api.setAiKey(key)).configured });
      },
      loadModels: async (force = false) => {
        const cached = get().models;
        if (cached && !force) return cached;
        const models = await api.aiModels();
        set({ models });
        return models;
      },
    }),
    {
      name: "data-based-ai",
      version: 1,
      partialize: (s) => ({ model: s.model, mode: s.mode, shareSamples: s.shareSamples }),
    }
  )
);

export const AI_NOT_READY = "Add your OpenRouter API key in Settings > AI to use AI features";
