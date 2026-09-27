//! Spreadsheet export: `.xlsx` written with rust_xlsxwriter in constant-memory
//! mode (rows stream to disk, so a large collection never sits in memory), and
//! `.numbers` made by asking Apple's Numbers app to open that xlsx and save it
//! in its own format - Numbers' format is private, and nothing but Numbers
//! writes it reliably. `.numbers` is therefore macOS-only and needs Numbers
//! installed ([`numbers_available`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use rust_xlsxwriter::{Format, Workbook, XlsxError};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// Excel's cell text limit.
const MAX_CELL_CHARS: usize = 32_767;
/// Excel: 1,048,576 rows per sheet; Numbers: 1,000,000 rows per table.
/// Both minus the header row.
pub const XLSX_MAX_ROWS: u64 = 1_048_575;
pub const NUMBERS_MAX_ROWS: u64 = 999_999;
const MAX_COLS: usize = 16_384;
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

impl From<XlsxError> for AppError {
    fn from(e: XlsxError) -> Self {
        AppError::Other(format!("spreadsheet: {e}"))
    }
}

/// "xlsx" / "numbers" - the formats this module writes.
pub fn is_sheet_format(format: &str) -> bool {
    matches!(format, "xlsx" | "numbers")
}

pub fn max_rows(format: &str) -> u64 {
    if format == "numbers" {
        NUMBERS_MAX_ROWS
    } else {
        XLSX_MAX_ROWS
    }
}

/// A single-sheet workbook being filled row by row.
pub struct SheetWriter {
    workbook: Workbook,
    columns: Vec<String>,
    row: u32,
    limit: u64,
    written: u64,
    truncated: bool,
    widths: Vec<usize>,
    date_fmt: Format,
    datetime_fmt: Format,
}

impl SheetWriter {
    /// Start a sheet with a bold, frozen header row of `columns`.
    pub fn new(columns: Vec<String>, sheet_name: &str, limit: u64) -> AppResult<Self> {
        let mut columns = columns;
        columns.truncate(MAX_COLS);
        let mut workbook = Workbook::new();
        let ws = workbook.add_worksheet_with_constant_memory();
        ws.set_name(sheet_title(sheet_name))?;
        let bold = Format::new().set_bold();
        for (i, c) in columns.iter().enumerate() {
            ws.write_string_with_format(0, i as u16, c, &bold)?;
        }
        ws.set_freeze_panes(1, 0)?;
        let widths = columns.iter().map(|c| c.chars().count()).collect();
        Ok(SheetWriter {
            workbook,
            columns,
            row: 1,
            limit,
            written: 0,
            truncated: false,
            widths,
            date_fmt: Format::new().set_num_format("yyyy-mm-dd"),
            datetime_fmt: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
        })
    }

    /// Append one row (a JSON object keyed by column). Returns `false` once
    /// the format's row limit is reached - the caller should stop.
    pub fn push(&mut self, row: &Map<String, Value>) -> AppResult<bool> {
        if self.written >= self.limit {
            self.truncated = true;
            return Ok(false);
        }
        let r = self.row;
        let (date_fmt, datetime_fmt) = (self.date_fmt.clone(), self.datetime_fmt.clone());
        let columns = self.columns.clone();
        let ws = self.workbook.worksheet_from_index(0)?;
        for (i, col) in columns.iter().enumerate() {
            let Some(v) = row.get(col) else { continue };
            let c = i as u16;
            let shown = match cell(v) {
                Cell::Empty => 0,
                Cell::Bool(b) => {
                    ws.write_boolean(r, c, b)?;
                    5
                }
                Cell::Number(n) => {
                    ws.write_number(r, c, n)?;
                    n.to_string().len()
                }
                Cell::Date(d) => {
                    ws.write_datetime_with_format(r, c, d, &date_fmt)?;
                    10
                }
                Cell::DateTime(d) => {
                    ws.write_datetime_with_format(r, c, d, &datetime_fmt)?;
                    19
                }
                Cell::Text(s) => {
                    // Always a string cell, never a formula - "=..." stays text.
                    ws.write_string(r, c, &s)?;
                    s.chars().count()
                }
            };
            if let Some(w) = self.widths.get_mut(i) {
                *w = (*w).max(shown);
            }
        }
        self.row += 1;
        self.written += 1;
        Ok(true)
    }

    /// Save to `path`. Returns (rows written, whether the row limit cut it short).
    pub fn save(mut self, path: &Path) -> AppResult<(u64, bool)> {
        let widths = std::mem::take(&mut self.widths);
        let ws = self.workbook.worksheet_from_index(0)?;
        for (i, w) in widths.iter().enumerate() {
            ws.set_column_width(i as u16, (*w as f64 + 2.0).clamp(8.0, 60.0))?;
        }
        self.workbook.save(path)?;
        Ok((self.written, self.truncated))
    }
}

/// Sheet names: max 31 chars, none of `[]:*?/\`, not blank.
fn sheet_title(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { '_' } else { c })
        .take(31)
        .collect();
    let cleaned = cleaned.trim().trim_matches('\'').to_string();
    if cleaned.is_empty() {
        "Export".into()
    } else {
        cleaned
    }
}

enum Cell {
    Empty,
    Bool(bool),
    Number(f64),
    Date(chrono::NaiveDate),
    DateTime(chrono::NaiveDateTime),
    Text(String),
}

fn text(s: String) -> Cell {
    if s.chars().count() > MAX_CELL_CHARS {
        let cut: String = s.chars().take(MAX_CELL_CHARS - 1).collect();
        Cell::Text(format!("{cut}…"))
    } else {
        Cell::Text(s)
    }
}

/// Exact integers past 2^53 would be rounded by a spreadsheet - keep them text.
fn number_or_text(n: f64, original: String) -> Cell {
    if n.is_finite() && (n.fract() != 0.0 || n.abs() <= MAX_SAFE_INT) {
        Cell::Number(n)
    } else {
        Cell::Text(original)
    }
}

/// ISO 8601 date / datetime text as a spreadsheet date (UTC when it carries an
/// offset). Anything else - or dates Excel can't hold (before 1900) - stays None.
fn parse_date(s: &str) -> Option<Cell> {
    let t = s.trim();
    if t.len() < 10 || !t.as_bytes()[..4].iter().all(u8::is_ascii_digit) || t.as_bytes()[4] != b'-' {
        return None;
    }
    let in_range = |y: i32| (1900..=9999).contains(&y);
    if t.len() == 10 {
        let d = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").ok()?;
        return in_range(chrono::Datelike::year(&d)).then_some(Cell::Date(d));
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
        let naive = dt.naive_utc();
        return in_range(chrono::Datelike::year(&naive)).then_some(Cell::DateTime(naive));
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(t, f) {
            return in_range(chrono::Datelike::year(&naive)).then_some(Cell::DateTime(naive));
        }
    }
    None
}

/// One JSON value (MongoDB relaxed Extended JSON or a Postgres row value) as a cell.
fn cell(v: &Value) -> Cell {
    match v {
        Value::Null => Cell::Empty,
        Value::Bool(b) => Cell::Bool(*b),
        Value::Number(n) => match n.as_f64() {
            Some(f) => number_or_text(f, n.to_string()),
            None => Cell::Text(n.to_string()),
        },
        Value::String(s) => parse_date(s).unwrap_or_else(|| text(s.clone())),
        Value::Object(o) if o.len() == 1 => {
            let (k, inner) = o.iter().next().unwrap();
            match (k.as_str(), inner) {
                ("$oid", Value::String(s)) => Cell::Text(s.clone()),
                ("$date", Value::String(s)) => parse_date(s).unwrap_or_else(|| Cell::Text(s.clone())),
                ("$date", Value::Object(d)) => match d.get("$numberLong").and_then(Value::as_str).and_then(|ms| ms.parse::<i64>().ok()) {
                    Some(ms) => match chrono::DateTime::from_timestamp_millis(ms) {
                        Some(dt) if (1900..=9999).contains(&chrono::Datelike::year(&dt)) => Cell::DateTime(dt.naive_utc()),
                        _ => Cell::Text(ms.to_string()),
                    },
                    None => text(inner.to_string()),
                },
                ("$numberLong" | "$numberInt" | "$numberDouble" | "$numberDecimal", Value::String(s)) => match s.parse::<f64>() {
                    // Decimal128 with more digits than a double holds stays text.
                    Ok(f) if !(k == "$numberDecimal" && s.trim_start_matches('-').replace('.', "").len() > 15) => {
                        number_or_text(f, s.clone())
                    }
                    _ => Cell::Text(s.clone()),
                },
                _ => text(v.to_string()),
            }
        }
        Value::Object(_) | Value::Array(_) => text(v.to_string()),
    }
}

/// Column order for a batch of rows: first-seen order, with `_id` first when present.
pub fn columns_of<'a>(rows: impl Iterator<Item = &'a Value>) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut has_id = false;
    for r in rows {
        if let Value::Object(m) = r {
            for k in m.keys() {
                if k == "_id" {
                    has_id = true;
                    continue;
                }
                if seen.insert(k.clone()) {
                    cols.push(k.clone());
                }
            }
        }
    }
    if has_id {
        cols.insert(0, "_id".into());
    }
    cols
}

/// Where an export's xlsx goes: the destination itself, or a temporary file
/// that Numbers converts.
pub fn staging_path(format: &str, dest: &Path) -> PathBuf {
    if format == "numbers" {
        std::env::temp_dir().join(format!("data-based-export-{}.xlsx", uuid::Uuid::new_v4()))
    } else {
        dest.to_path_buf()
    }
}

/// Finish an export written to `staged`: nothing to do for xlsx; for numbers,
/// convert to `dest` and remove the temporary xlsx.
pub fn finish(format: &str, staged: &Path, dest: &Path) -> AppResult<()> {
    if format != "numbers" {
        return Ok(());
    }
    let result = convert_to_numbers(staged, dest);
    let _ = std::fs::remove_file(staged);
    result
}

/// Write a batch of rows (Studio results, overview tables) to `path`.
pub fn write_rows(path: &Path, format: &str, sheet_name: &str, rows: &[Value]) -> AppResult<(u64, bool)> {
    if !is_sheet_format(format) {
        return Err(AppError::Other(format!("unknown spreadsheet format '{format}'")));
    }
    if format == "numbers" && !numbers_available() {
        return Err(AppError::Other(NUMBERS_MISSING.into()));
    }
    let mut w = SheetWriter::new(columns_of(rows.iter()), sheet_name, max_rows(format))?;
    for r in rows {
        if let Value::Object(m) = r {
            if !w.push(m)? {
                break;
            }
        }
    }
    let staged = staging_path(format, path);
    let out = w.save(&staged)?;
    finish(format, &staged, path)?;
    Ok(out)
}

pub const NUMBERS_MISSING: &str = "Numbers export needs Apple's Numbers app on this Mac - export .xlsx instead";

/// Numbers.app is installed (macOS only).
pub fn numbers_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/Numbers.app").exists() {
            return true;
        }
        std::process::Command::new("/usr/bin/mdfind")
            .arg("kMDItemCFBundleIdentifier == 'com.apple.iWork.Numbers'")
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Open `xlsx` in Numbers and save it as `dest` (.numbers). Numbers quits
/// again afterwards if it wasn't already running. The paths go in as script
/// arguments, never spliced into the script text.
#[cfg(target_os = "macos")]
fn convert_to_numbers(xlsx: &Path, dest: &Path) -> AppResult<()> {
    // Find the document by the temp file's (unique) name rather than "front
    // document": the user may have other spreadsheets open.
    const SCRIPT: &str = r#"
on run argv
  set src to POSIX file (item 1 of argv)
  set dst to POSIX file (item 2 of argv)
  set docName to item 3 of argv
  set wasRunning to application id "com.apple.iWork.Numbers" is running
  tell application id "com.apple.iWork.Numbers"
    open src
    set d to missing value
    repeat 150 times
      try
        set d to first document whose name is docName
        exit repeat
      end try
      delay 0.2
    end repeat
    if d is missing value then error "the imported document never appeared"
    save d in dst
    close d saving no
    if not wasRunning and (count of documents) is 0 then quit
  end tell
end run
"#;
    // One conversion at a time: two scripts driving Numbers at once race each
    // other (and one may quit it under the other).
    static NUMBERS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = NUMBERS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !numbers_available() {
        return Err(AppError::Other(NUMBERS_MISSING.into()));
    }
    let _ = std::fs::remove_file(dest); // "save in" won't replace a package
    let mut child = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(SCRIPT)
        .arg(xlsx)
        .arg(dest)
        .arg(xlsx.file_stem().and_then(|n| n.to_str()).unwrap_or(""))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(format!("could not start Numbers: {e}")))?;
    // Large sheets take Numbers a while; a hung permission prompt must not
    // block forever.
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => break,
            Some(_) => {
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    use std::io::Read;
                    let _ = s.read_to_string(&mut err);
                }
                return Err(AppError::Other(numbers_error(&err)));
            }
            None if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err(AppError::Other("Numbers didn't finish the conversion in 10 minutes".into()));
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    if !dest.exists() {
        return Err(AppError::Other("Numbers didn't write the file".into()));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn convert_to_numbers(_xlsx: &Path, _dest: &Path) -> AppResult<()> {
    Err(AppError::Other(NUMBERS_MISSING.into()))
}

/// osascript's stderr, in words: the Automation permission is the usual cause.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn numbers_error(stderr: &str) -> String {
    if stderr.contains("-1743") || stderr.to_lowercase().contains("not authorized") {
        return "macOS blocked Data Based from controlling Numbers - allow it in System Settings > Privacy & Security > Automation, then export again".into();
    }
    if stderr.contains("-128") {
        return "Numbers export was cancelled".into();
    }
    let line = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
    format!("Numbers couldn't convert the export: {}", line.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn is_text(c: Cell, want: &str) -> bool {
        matches!(c, Cell::Text(s) if s == want)
    }

    #[test]
    fn cell_types() {
        assert!(matches!(cell(&json!(3)), Cell::Number(n) if n == 3.0));
        assert!(matches!(cell(&json!(2.5)), Cell::Number(n) if n == 2.5));
        assert!(matches!(cell(&json!(true)), Cell::Bool(true)));
        assert!(matches!(cell(&json!(null)), Cell::Empty));
        assert!(is_text(cell(&json!("9007199254740993")), "9007199254740993"));
        assert!(is_text(cell(&json!({"$numberLong": "9007199254740993"})), "9007199254740993"));
        assert!(matches!(cell(&json!({"$numberLong": "42"})), Cell::Number(n) if n == 42.0));
        assert!(is_text(cell(&json!({"$numberDecimal": "12345678901234567.89"})), "12345678901234567.89"));
        assert!(is_text(cell(&json!({"$oid": "65f0c0ffee0000000000abcd"})), "65f0c0ffee0000000000abcd"));
        assert!(is_text(cell(&json!("=HYPERLINK(\"x\")")), "=HYPERLINK(\"x\")"));
        assert!(is_text(cell(&json!({"a": 1})), "{\"a\":1}"));
        assert!(is_text(cell(&json!([1, 2])), "[1,2]"));
    }

    #[test]
    fn dates() {
        assert!(matches!(cell(&json!("2024-05-01")), Cell::Date(_)));
        assert!(matches!(cell(&json!("2024-05-01T10:00:00Z")), Cell::DateTime(_)));
        assert!(matches!(cell(&json!("2024-05-01T10:00:00.123")), Cell::DateTime(_)));
        assert!(matches!(cell(&json!({"$date": "2024-05-01T10:00:00Z"})), Cell::DateTime(_)));
        assert!(matches!(cell(&json!({"$date": {"$numberLong": "-5000000000000"}})), Cell::Text(_)));
        // Before 1900 Excel can't store it as a date.
        assert!(is_text(cell(&json!("1815-12-10")), "1815-12-10"));
        assert!(is_text(cell(&json!("2024-13-40")), "2024-13-40"));
        assert!(is_text(cell(&json!("12345")), "12345"));
    }

    #[test]
    fn columns_put_id_first() {
        let rows = [json!({"b": 1, "_id": 2}), json!({"a": 3, "b": 4})];
        assert_eq!(columns_of(rows.iter()), vec!["_id", "b", "a"]);
    }

    #[test]
    fn sheet_names() {
        assert_eq!(sheet_title("a/b:c"), "a_b_c");
        assert_eq!(sheet_title(""), "Export");
        assert_eq!(sheet_title(&"x".repeat(40)).len(), 31);
    }

    #[test]
    fn writes_and_limits_rows() {
        let dir = std::env::temp_dir().join(format!("mb-sheet-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.xlsx");
        let mut w = SheetWriter::new(vec!["n".into(), "when".into()], "t", 2).unwrap();
        for i in 0..5 {
            let row = json!({"n": i, "when": "2024-01-02T03:04:05Z"});
            if !w.push(row.as_object().unwrap()).unwrap() {
                break;
            }
        }
        let (written, truncated) = w.save(&path).unwrap();
        assert_eq!((written, truncated), (2, true));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], b"PK"); // a zip container
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Real conversion through Numbers.app - opt in with MB_NUMBERS=1 (macOS,
    /// Numbers installed; the first run asks for Automation permission).
    #[test]
    fn live_numbers_conversion() {
        if std::env::var("MB_NUMBERS").is_err() || !numbers_available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("mb-numbers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("orders.numbers");
        let rows: Vec<Value> = (0..50)
            .map(|i| json!({"_id": {"$oid": "65f0c0ffee0000000000abcd"}, "n": i, "status": "paid", "at": {"$date": "2024-05-01T10:00:00Z"}}))
            .collect();
        let (written, truncated) = write_rows(&dest, "numbers", "orders", &rows).unwrap();
        assert_eq!((written, truncated), (50, false));
        assert!(dest.exists(), "no .numbers written");
        if std::env::var("MB_NUMBERS_KEEP").is_ok() {
            eprintln!("kept {}", dest.display());
            return;
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn numbers_errors_read_well() {
        assert!(numbers_error("execution error: Not authorized to send Apple events to Numbers. (-1743)").contains("Automation"));
        assert!(numbers_error("boom\n").contains("boom"));
    }
}
