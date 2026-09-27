//! One-time move from the pre-rename app id (`com.swlittles.mongobongo`,
//! "Mongo Bongo") to `com.swlittles.databased`. The OS keys every per-app
//! folder by that id, so a renamed build would otherwise start empty.
//!
//! Runs before the window (and its webview) exists. For each folder the app
//! owns - app data (connections, key file, settings, AI key, known_hosts) and
//! the webview's own storage (theme, chats, saved queries) - it copies the old
//! one to the new location when the new one doesn't exist yet. The old
//! folders are left alone: nothing is deleted, so a failed copy can be retried
//! on the next launch and the old build still works.

use std::path::{Path, PathBuf};

pub const IDENTIFIER: &str = "com.swlittles.databased";
pub const LEGACY_IDENTIFIER: &str = "com.swlittles.mongobongo";

/// Parent folders that hold a per-app `<identifier>` folder on this OS.
fn roots() -> Vec<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = env("HOME") {
        out.push(home.join("Library/Application Support"));
        // WKWebView's website data (localStorage lives here).
        out.push(home.join("Library/WebKit"));
    }
    #[cfg(target_os = "windows")]
    {
        out.extend(env("APPDATA"));
        // WebView2's EBWebView profile.
        out.extend(env("LOCALAPPDATA"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // App data and WebKitGTK storage share the XDG data dir.
        match env("XDG_DATA_HOME") {
            Some(d) => out.push(d),
            None => out.extend(env("HOME").map(|h| h.join(".local/share"))),
        }
    }
    let _ = &env;
    out
}

/// Copy the legacy folders across, once. Never fails the launch.
pub fn run() {
    for root in roots() {
        let _ = migrate_dir(&root.join(LEGACY_IDENTIFIER), &root.join(IDENTIFIER));
    }
}

/// Copy `old` to `new` when `new` is absent. Staged in a sibling folder and
/// renamed into place, so a half-finished copy never looks migrated.
pub fn migrate_dir(old: &Path, new: &Path) -> std::io::Result<bool> {
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    let staging = new.with_extension("migrating");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    copy_tree(old, &staging)?;
    std::fs::rename(&staging, new)?;
    Ok(true)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &dest)?;
            // Keep 0600 on the key file and secrets.
            #[cfg(unix)]
            {
                let perms = entry.metadata()?.permissions();
                std::fs::set_permissions(&dest, perms)?;
            }
        }
        // Symlinks (WebKit uses none we need) are skipped.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_once_and_keeps_the_original() {
        let root = std::env::temp_dir().join(format!("db-migrate-{}", uuid::Uuid::new_v4()));
        let old = root.join(LEGACY_IDENTIFIER);
        let new = root.join(IDENTIFIER);
        std::fs::create_dir_all(old.join("WebsiteData/Default")).unwrap();
        std::fs::write(old.join("connections.json"), b"{}").unwrap();
        std::fs::write(old.join("WebsiteData/Default/salt"), b"x").unwrap();

        assert!(migrate_dir(&old, &new).unwrap());
        assert_eq!(std::fs::read(new.join("connections.json")).unwrap(), b"{}");
        assert!(new.join("WebsiteData/Default/salt").exists());
        assert!(old.join("connections.json").exists(), "the original stays");
        assert!(!new.with_extension("migrating").exists());

        // Already migrated: the new folder is never overwritten.
        std::fs::write(new.join("connections.json"), b"{\"new\":1}").unwrap();
        assert!(!migrate_dir(&old, &new).unwrap());
        assert_eq!(std::fs::read(new.join("connections.json")).unwrap(), b"{\"new\":1}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn nothing_to_do_without_a_legacy_folder() {
        let root = std::env::temp_dir().join(format!("db-migrate-{}", uuid::Uuid::new_v4()));
        assert!(!migrate_dir(&root.join("missing"), &root.join("new")).unwrap());
        assert!(!root.join("new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("db-migrate-{}", uuid::Uuid::new_v4()));
        let old = root.join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("k.key"), [1u8; 32]).unwrap();
        std::fs::set_permissions(old.join("k.key"), std::fs::Permissions::from_mode(0o600)).unwrap();
        migrate_dir(&old, &root.join("new")).unwrap();
        let mode = std::fs::metadata(root.join("new/k.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(root).unwrap();
    }
}
