import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Doc } from "@/lib/api";
import type { ChartKind, TokenUsage, VizPlan } from "@/lib/ai";

/** Scope value meaning "every collection in the database" (joins allowed). */
export const WHOLE_DB = "*";

/** Result rows kept per turn on disk (the live copy keeps everything). */
const PERSIST_DOC_CAP = 50;
const SESSION_CAP = 30;

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text?: string;
  pending?: boolean;
  /** Progress line while pending ("Reading the schema", "Running the query"). */
  status?: string;
  error?: string;
  /** Refused: the request tried to change data. */
  blocked?: boolean;
  plan?: VizPlan;
  /** mongosh rendering of the plan. */
  query?: string;
  /** Collection the query ran on (the primary, for joins). */
  runCollection?: string;
  docs?: Doc[];
  docCount?: number;
  execMs?: number;
  chartType?: ChartKind | null;
  summary?: string | null;
  usage?: TokenUsage;
  /** Model that answered. */
  model?: string;
}

export interface ChatSession {
  id: string;
  /** Connection the chat belongs to (profile id, or workspace id for ad-hoc). */
  connection: string;
  title: string;
  database: string;
  /** A collection name, or WHOLE_DB. */
  scope: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

interface ChatState {
  sessions: ChatSession[];
  activeId: string | null;
  newSession: (connection: string, database: string, scope: string, title: string) => string;
  setActive: (id: string | null) => void;
  addTurn: (sessionId: string, turn: Omit<ChatTurn, "id">) => string;
  patchTurn: (sessionId: string, turnId: string, patch: Partial<ChatTurn>) => void;
  deleteSession: (id: string) => void;
  clearConnection: (connection: string) => void;
}

const touch = (s: ChatSession): ChatSession => ({ ...s, updatedAt: Date.now() });

export const useChat = create<ChatState>()(
  persist(
    (set) => ({
      sessions: [],
      activeId: null,

      newSession: (connection, database, scope, title) => {
        const id = newId("chat");
        const now = Date.now();
        const session: ChatSession = {
          id,
          connection,
          title: title.slice(0, 80) || "New chat",
          database,
          scope,
          createdAt: now,
          updatedAt: now,
          turns: [],
        };
        set((st) => ({ sessions: [session, ...st.sessions], activeId: id }));
        return id;
      },

      setActive: (id) => set({ activeId: id }),

      addTurn: (sessionId, turn) => {
        const turnId = newId("turn");
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === sessionId ? touch({ ...s, turns: [...s.turns, { ...turn, id: turnId }] }) : s
          ),
        }));
        return turnId;
      },

      patchTurn: (sessionId, turnId, patch) =>
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === sessionId
              ? touch({ ...s, turns: s.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t)) })
              : s
          ),
        })),

      deleteSession: (id) =>
        set((st) => ({
          sessions: st.sessions.filter((s) => s.id !== id),
          activeId: st.activeId === id ? null : st.activeId,
        })),

      clearConnection: (connection) =>
        set((st) => {
          const sessions = st.sessions.filter((s) => s.connection !== connection);
          return {
            sessions,
            activeId: sessions.some((s) => s.id === st.activeId) ? st.activeId : null,
          };
        }),
    }),
    {
      name: "mongo-bongo-chat",
      version: 1,
      // Bounded storage: recent sessions only, capped rows per turn, and no
      // half-finished turns (a pending turn cannot resume after a restart).
      partialize: (state) => ({
        activeId: state.activeId,
        sessions: state.sessions
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, SESSION_CAP)
          .map((s) => ({
            ...s,
            turns: s.turns.map((t) => {
              const kept = t.docs ? { ...t, docs: t.docs.slice(0, PERSIST_DOC_CAP) } : t;
              return kept.pending ? { ...kept, pending: false, status: undefined, error: "Interrupted" } : kept;
            }),
          })),
      }),
    }
  )
);
