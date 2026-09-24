<p align="center">
  <img src="public/icon.svg" width="104" alt="Mongo Bongo" />
</p>

<h1 align="center">Mongo Bongo</h1>

<p align="center"><b>A fast, native MongoDB desktop client.</b></p>

---

## Features

- Table, document, schema and index views for any collection
- Query dock with Find, Aggregate and an embedded shell ([syntax](MONGODB_SHELL_SYNTAX.md))
- Document drawer with typed field editing, a JSON editor and a diff view
- Several live connections at once, one click to switch
- Collection copy across connections, collection diff, bulk update/delete
- Production connections open read-only until you explicitly switch to edit mode
- Backups offered before destructive deletes, drops and clears
- Multiple themes and densities

## Security model

- Connection profiles live in the OS app-data directory; secrets are AES-256-GCM encrypted.
- The master key lives in a private (`0600`) key file by default, or in the OS keychain
  (Settings > Safety).
- Stored secrets are never sent back to the UI.
- Full-backup exports re-encrypt credentials under a passphrase you choose (Argon2id + AES-256-GCM).
- Strict CSP, no remote content, no telemetry. Everything is bundled and works offline.

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
