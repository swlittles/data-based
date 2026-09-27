//! Just enough SQL lexing for the shell: split a script into statements,
//! classify each one, and spot the statements a read-only session must refuse.
//!
//! The server is the real guard - read-only work runs inside
//! `BEGIN READ ONLY` - but a script could otherwise end that transaction
//! (`COMMIT; DELETE ...`) and carry on outside it, so transaction control is
//! rejected up front.

/// Split on top-level semicolons, respecting quotes, dollar quotes and
/// comments. Empty statements (and comment-only ones) are dropped.
pub fn split_statements(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' => i = skip_quoted(b, i, b'\'', b.get(i.wrapping_sub(1)).is_some_and(|c| *c == b'E' || *c == b'e')),
            b'"' => i = skip_quoted(b, i, b'"', false),
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => i = skip_block_comment(b, i),
            b'$' => match dollar_tag(b, i) {
                Some(tag) => i = skip_dollar(b, i, &tag),
                None => i += 1,
            },
            b';' => {
                push_stmt(&mut out, &text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    push_stmt(&mut out, &text[start..]);
    out
}

fn push_stmt(out: &mut Vec<String>, s: &str) {
    if !strip_comments_and_literals(s).trim().is_empty() {
        out.push(s.trim().to_string());
    }
}

/// Index just past the closing quote. `backslash` enables E'' escapes.
fn skip_quoted(b: &[u8], open: usize, q: u8, backslash: bool) -> usize {
    let mut i = open + 1;
    while i < b.len() {
        if backslash && b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == q {
            if b.get(i + 1) == Some(&q) {
                i += 2; // doubled quote
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    b.len()
}

fn skip_block_comment(b: &[u8], open: usize) -> usize {
    // Postgres block comments nest.
    let mut depth = 0;
    let mut i = open;
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    b.len()
}

/// `$tag$` starting at `i` (tag may be empty), unless it's a `$1` parameter.
fn dollar_tag(b: &[u8], i: usize) -> Option<String> {
    // `a$b$` is an identifier containing dollars, not a quote.
    if i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
        j += 1;
    }
    if j < b.len() && b[j] == b'$' {
        let tag = &b[i + 1..j];
        if tag.first().is_some_and(|c| c.is_ascii_digit()) {
            return None;
        }
        return Some(String::from_utf8_lossy(&b[i..=j]).into_owned());
    }
    None
}

fn skip_dollar(b: &[u8], open: usize, tag: &str) -> usize {
    let t = tag.as_bytes();
    let mut i = open + t.len();
    while i + t.len() <= b.len() {
        if &b[i..i + t.len()] == t {
            return i + t.len();
        }
        i += 1;
    }
    b.len()
}

/// The statement with comments removed and string / quoted-identifier / dollar
/// bodies blanked, so keyword checks never match inside data.
pub fn strip_comments_and_literals(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        let next = match b[i] {
            b'\'' => Some(skip_quoted(b, i, b'\'', b.get(i.wrapping_sub(1)).is_some_and(|c| *c == b'E' || *c == b'e'))),
            b'"' => {
                // Identifiers stay (lower-cased keywords may hide in them, but
                // they are names, not code) - keep them verbatim.
                let end = skip_quoted(b, i, b'"', false);
                out.push_str(&s[i..end]);
                i = end;
                continue;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                let mut j = i;
                while j < b.len() && b[j] != b'\n' {
                    j += 1;
                }
                Some(j)
            }
            b'/' if b.get(i + 1) == Some(&b'*') => Some(skip_block_comment(b, i)),
            b'$' => dollar_tag(b, i).map(|tag| skip_dollar(b, i, &tag)),
            _ => None,
        };
        match next {
            Some(end) => {
                out.push(' ');
                i = end;
            }
            None => {
                // Copy one UTF-8 character.
                let ch_len = s[i..].chars().next().map(char::len_utf8).unwrap_or(1);
                out.push_str(&s[i..i + ch_len]);
                i += ch_len;
            }
        }
    }
    out
}

/// Upper-cased leading words (up to `n`), skipping comments and opening parens.
pub fn leading_words(stmt: &str, n: usize) -> Vec<String> {
    strip_comments_and_literals(stmt)
        .split(|c: char| c.is_whitespace() || c == '(' || c == ';')
        .filter(|w| !w.is_empty())
        .take(n)
        .map(|w| w.to_ascii_uppercase())
        .collect()
}

/// Statements that return rows (so the shell shows them as documents).
pub fn returns_rows(stmt: &str) -> bool {
    let words = leading_words(stmt, 1);
    let code = strip_comments_and_literals(stmt).to_ascii_uppercase();
    match words.first().map(String::as_str) {
        Some("SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN" | "FETCH") => true,
        Some("INSERT" | "UPDATE" | "DELETE" | "MERGE") => code.contains("RETURNING"),
        _ => false,
    }
}

/// Why a statement can't run in a read-only session, if it can't.
pub fn read_only_violation(stmt: &str) -> Option<String> {
    let words = leading_words(stmt, 4);
    let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    let first = w(0);
    let blocked = match first {
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "DISCARD" => true,
        "PREPARE" => w(1) == "TRANSACTION",
        "SET" | "RESET" => {
            let target = if matches!(w(1), "SESSION" | "LOCAL") { w(2) } else { w(1) };
            matches!(
                target,
                "TRANSACTION" | "CHARACTERISTICS" | "ALL" | "ROLE" | "AUTHORIZATION"
            ) || target.contains("READ_ONLY")
                || target.contains("TRANSACTION")
                || w(2) == "CHARACTERISTICS"
        }
        _ => false,
    };
    blocked.then(|| {
        format!(
            "{} isn't allowed while the workspace is read-only - switch to edit mode in the status bar first",
            words.iter().take(2).cloned().collect::<Vec<_>>().join(" ")
        )
    })
}

/// A short tag for a statement that returned no rows ("CREATE TABLE", "UPDATE").
pub fn command_tag(stmt: &str) -> String {
    let words = leading_words(stmt, 6);
    let w = |i: usize| words.get(i).cloned().unwrap_or_default();
    match w(0).as_str() {
        "CREATE" | "DROP" | "ALTER" => {
            // CREATE [OR REPLACE] [UNIQUE|TEMP|MATERIALIZED] <object>
            let object: Vec<String> = words
                .iter()
                .skip(1)
                .filter(|x| !matches!(x.as_str(), "OR" | "REPLACE" | "UNIQUE" | "TEMP" | "TEMPORARY" | "UNLOGGED" | "IF"))
                .take(1)
                .cloned()
                .collect();
            format!("{} {}", w(0), object.join(" ")).trim().to_string()
        }
        "" => "OK".into(),
        first => first.to_string(),
    }
}

/// `SET search_path TO x` / `SET schema 'x'` - the shell follows it so later
/// runs in the tab keep the chosen schema.
pub fn search_path_target(stmt: &str) -> Option<String> {
    let t = stmt.trim().trim_end_matches(';').trim();
    let lower = t.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("set search_path")
        .map(|r| r.trim_start())
        .and_then(|r| r.strip_prefix("to").or_else(|| r.strip_prefix('=')))
        .or_else(|| lower.strip_prefix("set schema"))?;
    let offset = t.len() - rest.len();
    let first = t[offset..].split(',').next()?.trim();
    let name = first.trim_matches(|c| c == '"' || c == '\'').trim();
    (!name.is_empty() && !name.eq_ignore_ascii_case("default")).then(|| name.to_string())
}

/// Checks for SQL that AI Studio (or any other read-only runner) is about to
/// execute: exactly one statement, a query, and none of the functions that
/// reach outside the database even inside a read-only transaction.
pub fn check_read_only_query(sql: &str) -> Result<String, String> {
    let statements = split_statements(sql);
    let stmt = match statements.as_slice() {
        [one] => one.clone(),
        [] => return Err("the query is empty".into()),
        _ => return Err("only a single statement can run here".into()),
    };
    let first = leading_words(&stmt, 1).into_iter().next().unwrap_or_default();
    if !matches!(first.as_str(), "SELECT" | "WITH" | "VALUES" | "TABLE") {
        return Err(format!("only queries can run here, not {first}"));
    }
    let code = strip_comments_and_literals(&stmt).to_ascii_lowercase();
    const DENY: &[&str] = &[
        "pg_terminate_backend",
        "pg_cancel_backend",
        "pg_reload_conf",
        "pg_rotate_logfile",
        "pg_read_file",
        "pg_read_binary_file",
        "pg_ls_",
        "pg_stat_file",
        "lo_import",
        "lo_export",
        "lo_unlink",
        "dblink",
        "set_config",
        "pg_advisory",
        "pg_promote",
        "pg_switch_wal",
        "pg_create_restore_point",
        "pg_notify",
        "pg_sleep",
    ];
    if let Some(bad) = DENY.iter().find(|f| code.contains(*f)) {
        return Err(format!("{} isn't allowed in a read-only query", bad.trim_end_matches('_')));
    }
    // Data-modifying CTEs (WITH x AS (DELETE ...)) and SELECT ... INTO are
    // refused by the read-only transaction too; failing early reads better.
    let words: Vec<&str> = code
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();
    for kw in ["insert", "update", "delete", "merge", "truncate", "into"] {
        if words.contains(&kw) {
            return Err(if kw == "into" {
                "SELECT ... INTO creates a table and isn't allowed here".into()
            } else {
                format!("{} isn't allowed in a read-only query", kw.to_ascii_uppercase())
            });
        }
    }
    Ok(stmt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_respecting_literals() {
        let s = split_statements(
            "select 'a;b'; select \"x;y\" from t; -- c;\n select $$ ; $$; select $f$ a;b $f$ ;/* ; */ select 1",
        );
        assert_eq!(s.len(), 5);
        assert_eq!(s[0], "select 'a;b'");
        assert_eq!(s[4], "/* ; */ select 1");
        assert!(split_statements("  ; -- only a comment\n ;").is_empty());
    }

    #[test]
    fn splits_escape_strings_and_params() {
        let s = split_statements("select E'it\\'s;'; select $1::int; select a$b$c from t");
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn nested_block_comments() {
        assert_eq!(split_statements("/* a /* ; */ ; */ select 1").len(), 1);
    }

    #[test]
    fn classifies() {
        assert!(returns_rows("  (select 1)"));
        assert!(returns_rows("with x as (select 1) select * from x"));
        assert!(returns_rows("insert into t values (1) returning id"));
        assert!(!returns_rows("insert into t values ('returning')"));
        assert!(!returns_rows("update t set a = 1"));
        assert_eq!(command_tag("create unique index on t (a)"), "CREATE INDEX");
        assert_eq!(command_tag("create or replace view v as select 1"), "CREATE VIEW");
        assert_eq!(command_tag("delete from t"), "DELETE");
    }

    #[test]
    fn read_only_guard() {
        assert!(read_only_violation("COMMIT").is_some());
        assert!(read_only_violation("  begin read write").is_some());
        assert!(read_only_violation("set transaction read write").is_some());
        assert!(read_only_violation("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE").is_some());
        assert!(read_only_violation("set default_transaction_read_only = off").is_some());
        assert!(read_only_violation("reset all").is_some());
        assert!(read_only_violation("prepare transaction 'x'").is_some());
        assert!(read_only_violation("select 'commit'").is_none());
        assert!(read_only_violation("set search_path to app").is_none());
        assert!(read_only_violation("prepare q as select 1").is_none());
    }

    #[test]
    fn search_path() {
        assert_eq!(search_path_target("SET search_path TO app, public;").as_deref(), Some("app"));
        assert_eq!(search_path_target("set search_path = \"My Schema\"").as_deref(), Some("My Schema"));
        assert_eq!(search_path_target("set schema 'x'").as_deref(), Some("x"));
        assert_eq!(search_path_target("select 1"), None);
    }

    #[test]
    fn studio_guard() {
        assert!(check_read_only_query("select * from t where name = 'delete me'").is_ok());
        assert!(check_read_only_query("with x as (select 1) select * from x;").is_ok());
        assert!(check_read_only_query("select 1; select 2").is_err());
        assert!(check_read_only_query("delete from t").is_err());
        assert!(check_read_only_query("with d as (delete from t returning *) select * from d").is_err());
        assert!(check_read_only_query("select pg_terminate_backend(1)").is_err());
        assert!(check_read_only_query("select * into newt from t").is_err());
        assert!(check_read_only_query("select updated_at, inserted_by from t").is_ok());
    }
}
