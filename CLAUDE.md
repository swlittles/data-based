# Mongo Bongo - project instructions

Tauri 2 (Rust, `src-tauri/`) + React 19 / Vite / Tailwind (`src/`) MongoDB and PostgreSQL
desktop client.

## Commands

- `npm run tauri dev` - run the desktop app
- `npm run dev` - browser-only preview (Tauri bridge mocked by `src/dev/mockTauri.ts`)
- `npm run typecheck`, `npm test` - TypeScript check and Vitest
- `cargo check` / `cargo test` in `src-tauri/`
- Postgres end-to-end tests (`src-tauri/src/pg/live_tests.rs`) run only when `MB_PG_URL` points
  at a disposable database: `MB_PG_URL=postgresql://postgres:secret@localhost:5432/postgres cargo test live`
  (optional `MB_PG_CA=<ca.pem>` for the verify-full test)

## PostgreSQL

- The engine is picked by the connection string scheme (`postgres://` / `postgresql://`).
  `src-tauri/src/pg/` holds the backend: `mod.rs` (URI parsing, libpq-style `sslmode`, pool,
  `with_tx`), `value.rs` (binary values -> JSON), `sql.rs` (statement splitting, read-only
  guard), `ops.rs` (explorer operations). Each command in `commands.rs` branches on
  `pg_for(...)` first; Mongo code paths are untouched.
- The explorer keeps MongoDB's vocabulary: database = schema, collection = table/view,
  document = row (plain JSON), `_id` = primary key object. `src/lib/engine.ts` holds the
  engine differences for the UI (`terms`, row identity, SQL quoting); `useEngine()` and
  `useIdentity(tab)` read them in components. Query boxes take SQL fragments.
- Every Postgres read runs in `BEGIN READ ONLY` (rolled back); read-only workspaces run the SQL
  shell the same way and refuse transaction control. Studio uses `sql_query`, which also
  rejects anything but a single SELECT. Use unnamed statements (`query_typed`) only - named
  prepared statements break transaction-mode poolers (PgBouncer, Supavisor).

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
  `readOnly: true` so the backend rejects `$out` / `$merge`, and Postgres queries only via
  `sql_query` (a single SELECT inside a READ ONLY transaction).
- `src/dev/mockTauri.ts` fakes OpenRouter replies so the AI UI works in `npm run dev`.

## Behaviour to preserve

- Connections can be flagged `production`; a production workspace opens
  read-only and the user must switch to edit mode explicitly.
- Destructive multi-document deletes offer an optional JSON backup first;
  dropping a collection requires typing its name and offers an optional
  export.
