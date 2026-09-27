<p align="center">
  <img src="public/icon.svg" width="104" alt="Mongo Bongo" />
</p>

<h1 align="center">Mongo Bongo</h1>

<p align="center"><b>A fast, native MongoDB and PostgreSQL desktop client.</b></p>

---

## Features

- Table, document, schema and index views for any collection
- Query dock with Find, Aggregate and an embedded shell ([syntax](MONGODB_SHELL_SYNTAX.md))
- Document drawer with typed field editing, a JSON editor and a diff view
- Several live connections at once, one click to switch
- Collection copy across connections, collection diff, bulk update/delete
- Production connections open read-only until you explicitly switch to edit mode
- Backups offered before destructive deletes, drops and clears
- SSH tunnels (key, password or agent) and a database overview with storage, index and reference insights
- Multiple themes and densities

## PostgreSQL

Connect to any PostgreSQL server with a `postgresql://` URI or the form: Neon, Supabase, Tiger Cloud / Timescale,
RDS / Aurora, PlanetScale Postgres, Cloud SQL, Azure, Crunchy Bridge, Render, Railway or your own. TLS follows libpq's
`sslmode` (`disable` to `verify-full`, optional `sslrootcert`); transaction-mode poolers (PgBouncer, Supavisor) work.

- The same console: schemas in the picker, tables / views / materialized views as tabs, rows as plain JSON
- SQL in the query dock (filter = `WHERE` condition, sort = `ORDER BY`, projection = column list), a visual
  `WHERE` builder, `EXPLAIN ANALYZE` plans and a SQL shell
- Rows are edited and deleted by primary key; tables without one are read-only row by row
- Read-only and production workspaces run every statement in a `READ ONLY` transaction, so the server itself
  refuses writes; Studio runs a single checked `SELECT` the same way
- Import / export JSON, NDJSON and CSV; copy, duplicate and diff tables between Postgres connections

## AI (OpenRouter)

Bring your own [OpenRouter](https://openrouter.ai) key (Settings > AI) and pick any model it offers.

- **Studio** (⌘J): ask a question in plain English; get a read-only query, its rows and a bar, line or
  single-number chart. Works on one collection or across a whole database with joins. Follow-ups, saved
  questions, result summaries, CSV/JSON export, and "Open in Shell" for every generated query.
- **Shell assist**: fix, optimize, explain, suggest indexes or add safety limits to a statement.
- **Explain plans**: a plain-language verdict and the one fix that matters most.

Studio never writes: write requests are refused and the backend rejects `$out` / `$merge` on its queries
(PostgreSQL: one `SELECT`, inside a `READ ONLY` transaction). The key
is stored encrypted and never reaches the UI. Nothing goes to OpenRouter until you use an AI feature; collection
and field names are always sent, sample documents and result rows only while "Share sample data" is on.

## Security model

- Connection profiles live in the OS app-data directory; secrets are AES-256-GCM encrypted.
- The master key lives in a private (`0600`) key file by default, or in the OS keychain
  (Settings > Safety).
- Stored secrets are never sent back to the UI.
- Full-backup exports re-encrypt credentials under a passphrase you choose (Argon2id + AES-256-GCM).
- Strict CSP, no remote content, no telemetry. Everything is bundled and works offline; AI calls go from the Rust
  backend to OpenRouter only when you use them.

## Development

**Prerequisites:** [Rust](https://rustup.rs), Node 20+, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev      # run the desktop app
npm run tauri build    # produce a bundle for your OS
npm run typecheck && npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm run dev` on its own serves the UI in a normal browser with an in-memory Tauri shim
(`src/dev/mockTauri.ts`) and a fake server. It is never part of a production bundle.

Releases and the self-updater are covered in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party licenses.
