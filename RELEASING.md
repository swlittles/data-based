# Releasing Mongo Bongo

Releases are fully automated: **push to the `production` branch** and GitHub
Actions builds macOS (Apple Silicon), Windows, and Linux bundles,
creates a `v<version>` GitHub release, and publishes the signed updater
manifest (`latest.json`) that running apps poll for self-updates.

## One-time setup (repo secrets)

The updater artifacts must be signed. The keypair was generated locally with
`tauri signer generate` (with a password - GitHub cannot store an empty
secret, so passwordless keys do not work in CI):

- **Private key**: `~/.tauri/mongo-bongo.key` *(on the machine that generated it - never commit this file)*
- **Key password**: `~/.tauri/mongo-bongo.key.password`
- **Public key**: already embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`

Add two secrets under **GitHub repo → Settings → Secrets and variables →
Actions**:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The full contents of `~/.tauri/mongo-bongo.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The contents of `~/.tauri/mongo-bongo.key.password` |

```bash
# convenient way to add them with the GitHub CLI
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/mongo-bongo.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < ~/.tauri/mongo-bongo.key.password
```

> ⚠️ Back up both the private key **and its password** somewhere safe
> (password manager). If either is lost, existing installs can no longer
> verify updates - you'd have to ship a new pubkey and users would need to
> reinstall manually once.

## Cutting a release

1. Bump the version in **`src-tauri/tauri.conf.json`** (this is the version
   the release tag uses), and keep `package.json` + `src-tauri/Cargo.toml`
   in sync.
2. Merge / push to `production`:

   ```bash
   git checkout production || git checkout -b production
   git merge main
   git push origin production
   ```

3. The **Release** workflow builds all three targets in parallel and
   publishes the release. It does not re-run tests: CI already ran them on
   `main`, so only merge to `production` from a green `main`. Existing
   installs see the update on next launch (or via *Settings → Check for
   updates...*) and self-update from the GitHub release.

## How the updater works

- `createUpdaterArtifacts` makes the bundler emit update packages plus
  `.sig` files signed with your private key.
- `tauri-apps/tauri-action` aggregates them into `latest.json` on the
  release.
- The app checks
  `https://github.com/swlittles/data-based/releases/latest/download/latest.json`
  on startup (production builds only), verifies the signature against the
  embedded pubkey, downloads, installs, and relaunches.

## Local release builds

For a build on this machine only (the fastest way to try a release on your
own Mac), with the signing key in `~/.tauri`:

```bash
npm run build:local
```

It signs the updater artifacts exactly like CI and prints the bundle paths
(`src-tauri/target/release/bundle/`). Without the key, temporarily set
`"createUpdaterArtifacts": false` in `tauri.conf.json` for an unsigned bundle.

## Notes

- Intel Macs are not built. To add them back, restore the `macOS (Intel)`
  matrix entry (`--target x86_64-apple-darwin`) in `release.yml`. macOS
  minutes cost 10x Linux minutes on a private repo, which is why it was cut.
- Builds are unsigned by Apple/Microsoft (fine for an OSS tool; macOS users
  may need right-click → Open on first launch). Apple notarization can be
  added later by setting the `APPLE_*` secrets and uncommenting nothing - 
  tauri-action picks them up automatically when present.
- Manual run: the workflow also has a `workflow_dispatch` trigger, so you can
  fire it from the Actions tab without pushing.
