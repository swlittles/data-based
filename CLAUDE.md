# Mongo Bongo - project instructions

Tauri 2 (Rust, `src-tauri/`) + React 19 / Vite / Tailwind (`src/`) MongoDB desktop client.

## Commands

- `npm run tauri dev` - run the desktop app
- `npm run dev` - browser-only preview (Tauri bridge mocked by `src/dev/mockTauri.ts`)
- `npm run typecheck`, `npm test` - TypeScript check and Vitest
- `cargo check` / `cargo test` in `src-tauri/`

## Design system

- `src/styles/theme-kit.css` defines the token contract; `src/styles/app.css` is the
  component layer. Components read only the tokens (`--bg`, `--panel`, `--accent`,
  `--row`, ...) - never literal colours.
- Two attributes on `<html>` drive everything: `data-theme` and `data-density`.
- The mark is `<BrandMark />` (`src/components/brand/BrandMark.tsx`) and always
  paints with `currentColor`; in-app it sits on `var(--accent)`.

## AI

- OpenRouter is the only provider. `src-tauri/src/ai.rs` proxies every call; the key
  lives encrypted in `ai_key.json` and is write-only from the webview.
- Prompts live in `src/lib/ai.ts`; settings in `src/stores/ai.ts`; Studio in
  `src/components/studio/`. Studio must stay read-only: it runs aggregations with
  `readOnly: true` so the backend rejects `$out` / `$merge`.
- `src/dev/mockTauri.ts` fakes OpenRouter replies so the AI UI works in `npm run dev`.

## Behaviour to preserve

- Connections can be flagged `production`; a production workspace opens
  read-only and the user must switch to edit mode explicitly.
- Destructive multi-document deletes offer an optional JSON backup first;
  dropping a collection requires typing its name and offers an optional
  export.
