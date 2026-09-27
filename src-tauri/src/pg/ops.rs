//! Explorer operations for PostgreSQL workspaces.
//!
//! The explorer's vocabulary maps onto Postgres like this: a MongoDB
//! "database" is a schema, a "collection" is a table (or view), a "document"
//! is a row as a JSON object, and a document's `_id` is the row's primary key
//! as an object (`{"id": 7}` or `{"order_id": 1, "line": 2}`).
//!
//! The query boxes take SQL fragments instead of filter documents: a WHERE
//! condition, an ORDER BY list and a column list. Every read runs inside a
//! read-only transaction; writes run in their own committed transaction.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::{pin_mut, TryStreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio_postgres::types::{ToSql, Type};

use super::value::row_to_json;
use super::{qi, read, rel, write, PgClient, PgConn};
use crate::commands::{
    CollInfo, CollectionOverview, CollectionRef, CopyOutcome, CountResult, DbInfo, DbOverview,
    DiffEntry, DiffOutcome, DocsPage, IndexInfo, ShellOutcome,
};
use crate::error::{AppError, AppResult};

const COUNT_TIMEOUT: Duration = Duration::from_secs(4);
const SHELL_ROW_LIMIT: usize = 1000;
const BATCH: usize = 500;
const DIFF_DETAIL_CAP: usize = 200;

type Param<'a> = (&'a (dyn ToSql + Sync), Type);

fn text<'a>(s: &'a String) -> Param<'a> {
    (s as &(dyn ToSql + Sync), Type::TEXT)
}

fn jsonb(v: &Value) -> Param<'_> {
    (v as &(dyn ToSql + Sync), Type::JSONB)
}

fn ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// A query-box fragment, or `None` when blank. `{}` counts as blank so a
/// MongoDB-style default carried over by the UI never reaches the server.
fn frag(s: &str) -> Option<&str> {
    let t = s.trim().trim_end_matches(';').trim();
    (!t.is_empty() && t != "{}").then_some(t)
}

// ---------------------------------------------------------------------------
// table metadata
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// "a" (always) / "d" (by default) for identity columns.
    pub identity: Option<String>,
    /// Stored generated column - never written directly.
    pub generated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    /// "table" | "partitioned" | "view" | "matview" | "foreign"
    pub kind: String,
    pub columns: Vec<ColumnMeta>,
    /// Primary key columns in key order; empty when the table has none.
    pub primary_key: Vec<String>,
    pub comment: Option<String>,
}

impl TableMeta {
    fn column(&self, name: &str) -> Option<&ColumnMeta> {
        self.columns.iter().find(|c| c.name == name)
    }
    pub fn editable(&self) -> bool {
        matches!(self.kind.as_str(), "table" | "partitioned" | "foreign")
    }
}

fn kind_name(relkind: &str) -> &'static str {
    match relkind {
        "r" => "table",
        "p" => "partitioned",
        "v" => "view",
        "m" => "matview",
        "f" => "foreign",
        _ => "table",
    }
}

async fn meta_on(client: &PgClient, schema: &String, table: &String) -> AppResult<TableMeta> {
    let head = client
        .query_typed_opt(
            "SELECT c.relkind::text, obj_description(c.oid, 'pg_class')
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
            &[text(schema), text(table)],
        )
        .await?
        .ok_or_else(|| AppError::Other(format!("table {schema}.{table} not found")))?;
    let relkind: String = head.get(0);
    let comment: Option<String> = head.get(1);
    let rows = client
        .query_typed(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid), NULLIF(a.attidentity::text, ''),
                    a.attgenerated::text = 's',
                    array_position(i.indkey::int2[], a.attnum)
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[text(schema), text(table)],
        )
        .await?;
    let mut pk: Vec<(i32, String)> = Vec::new();
    let columns = rows
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            if let Some(pos) = r.get::<_, Option<i32>>(6) {
                pk.push((pos, name.clone()));
            }
            ColumnMeta {
                name,
                data_type: r.get(1),
                nullable: r.get(2),
                default: r.get(3),
                identity: r.get(4),
                generated: r.get::<_, Option<bool>>(5).unwrap_or(false),
            }
        })
        .collect();
    pk.sort();
    Ok(TableMeta {
        kind: kind_name(&relkind).to_string(),
        columns,
        primary_key: pk.into_iter().map(|(_, n)| n).collect(),
        comment,
    })
}

pub async fn table_meta(conn: &PgConn, schema: &str, table: &str) -> AppResult<TableMeta> {
    let (s, t) = (schema.to_string(), table.to_string());
    read(conn, None, async |c| meta_on(c, &s, &t).await).await
}

/// Metadata of every table / view in a schema in one round trip (AI prompts
/// describe whole schemas; one `table_meta` per table would be slow).
pub async fn schema_meta(conn: &PgConn, schema: &str) -> AppResult<HashMap<String, TableMeta>> {
    let s = schema.to_string();
    read(conn, None, async |c| {
        let rels = c
            .query_typed(
                "SELECT c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition",
                &[text(&s)],
            )
            .await?;
        let mut out: HashMap<String, TableMeta> = rels
            .iter()
            .map(|r| {
                (
                    r.get::<_, String>(0),
                    TableMeta {
                        kind: kind_name(&r.get::<_, String>(1)).to_string(),
                        columns: Vec::new(),
                        primary_key: Vec::new(),
                        comment: r.get(2),
                    },
                )
            })
            .collect();
        let cols = c
            .query_typed(
                "SELECT c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid), NULLIF(a.attidentity::text, ''),
                        a.attgenerated::text = 's', array_position(i.indkey::int2[], a.attnum)
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
                   AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY c.relname, a.attnum",
                &[text(&s)],
            )
            .await?;
        let mut pks: HashMap<String, Vec<(i32, String)>> = HashMap::new();
        for r in &cols {
            let table: String = r.get(0);
            let name: String = r.get(1);
            if let Some(pos) = r.get::<_, Option<i32>>(7) {
                pks.entry(table.clone()).or_default().push((pos, name.clone()));
            }
            if let Some(meta) = out.get_mut(&table) {
                meta.columns.push(ColumnMeta {
                    name,
                    data_type: r.get(2),
                    nullable: r.get(3),
                    default: r.get(4),
                    identity: r.get(5),
                    generated: r.get::<_, Option<bool>>(6).unwrap_or(false),
                });
            }
        }
        for (table, mut key) in pks {
            key.sort();
            if let Some(meta) = out.get_mut(&table) {
                meta.primary_key = key.into_iter().map(|(_, n)| n).collect();
            }
        }
        Ok(out)
    })
    .await
}

// ---------------------------------------------------------------------------
// schemas & tables
// ---------------------------------------------------------------------------

const USER_SCHEMAS: &str = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

pub async fn list_schemas(conn: &PgConn) -> AppResult<Vec<DbInfo>> {
    read(conn, None, async |c| {
        let rows = c
            .query_typed(
                &format!(
                    "SELECT n.nspname::text,
                            COALESCE(SUM(pg_total_relation_size(cl.oid)) FILTER (WHERE cl.relkind IN ('r','m','p')), 0)::bigint,
                            COUNT(cl.oid) FILTER (WHERE cl.relkind IN ('r','v','m','p','f'))
                     FROM pg_namespace n
                     LEFT JOIN pg_class cl ON cl.relnamespace = n.oid
                     WHERE {USER_SCHEMAS}
                     GROUP BY n.nspname
                     ORDER BY lower(n.nspname)"
                ),
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| DbInfo {
                name: r.get(0),
                size_on_disk: Some(r.get::<_, i64>(1).max(0) as u64),
                empty: Some(r.get::<_, i64>(2) == 0),
            })
            .collect())
    })
    .await
}

pub async fn list_tables(conn: &PgConn, schema: &str) -> AppResult<Vec<CollInfo>> {
    let s = schema.to_string();
    read(conn, None, async |c| {
        let rows = c
            .query_typed(
                "SELECT c.relname::text, c.relkind::text
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
                 ORDER BY lower(c.relname)",
                &[text(&s)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| CollInfo { name: r.get(0), kind: kind_name(&r.get::<_, String>(1)).to_string() })
            .collect())
    })
    .await
}

/// Estimated rows per table: planner statistics, falling back to the stats
/// collector's live-tuple count for never-analyzed tables.
pub async fn table_counts(conn: &PgConn, schema: &str) -> AppResult<HashMap<String, u64>> {
    let s = schema.to_string();
    read(conn, None, async |c| {
        let rows = c
            .query_typed(
                "SELECT c.relname::text,
                        CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint
                             ELSE COALESCE(st.n_live_tup, 0) END
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','m','f')",
                &[text(&s)],
            )
            .await?;
        Ok(rows.iter().map(|r| (r.get(0), r.get::<_, i64>(1).max(0) as u64)).collect())
    })
    .await
}

pub async fn ping(conn: &PgConn) -> AppResult<u64> {
    let started = Instant::now();
    let client = conn.pool.get().await?;
    tokio::time::timeout(Duration::from_secs(5), client.query_typed("SELECT 1", &[]))
        .await
        .map_err(|_| AppError::Other("ping timed out".into()))??;
    Ok(ms(started))
}

// ---------------------------------------------------------------------------
// reading rows
// ---------------------------------------------------------------------------

/// `SELECT <cols> FROM <table> WHERE (<filter>) ORDER BY <sort>`. Each
/// fragment sits on its own line so a trailing `-- comment` can't swallow the
/// clauses after it.
fn select_sql(schema: &str, table: &str, filter: &str, sort: &str, projection: &str) -> String {
    let mut sql = format!(
        "SELECT {}\nFROM {}",
        frag(projection).map(|p| format!("\n{p}\n")).unwrap_or_else(|| "*".into()),
        rel(schema, table)
    );
    if let Some(f) = frag(filter) {
        sql.push_str(&format!("\nWHERE (\n{f}\n)"));
    }
    if let Some(s) = frag(sort) {
        sql.push_str(&format!("\nORDER BY\n{s}\n"));
    }
    sql
}

/// Stream up to `limit` rows as JSON; the flag says whether more were left.
async fn collect_rows(client: &PgClient, sql: &str, params: &[Param<'_>], limit: usize) -> AppResult<(Vec<Value>, bool, Option<u64>)> {
    let stream = client.query_typed_raw(sql, params.iter().map(|(v, t)| (*v, t.clone()))).await?;
    pin_mut!(stream);
    let mut rows = Vec::new();
    let mut more = false;
    while let Some(row) = stream.try_next().await? {
        if rows.len() >= limit {
            more = true;
            break;
        }
        rows.push(row_to_json(&row));
    }
    let affected = if more { None } else { stream.rows_affected() };
    Ok((rows, more, affected))
}

#[allow(clippy::too_many_arguments)]
pub async fn find(
    conn: &PgConn,
    schema: &str,
    table: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    limit: i64,
    skip: u64,
) -> AppResult<DocsPage> {
    let limit = limit.clamp(1, 1000);
    let sql = format!(
        "{}\nLIMIT {limit} OFFSET {skip}",
        select_sql(schema, table, filter, sort, projection)
    );
    let started = Instant::now();
    let docs = read(conn, None, async |c| Ok(collect_rows(c, &sql, &[], limit as usize).await?.0)).await?;
    Ok(DocsPage { docs, exec_ms: ms(started), applied_default_limit: false })
}

fn is_timeout(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED)
}

pub async fn count(conn: &PgConn, schema: &str, table: &str, filter: &str) -> AppResult<CountResult> {
    let started = Instant::now();
    let (s, t) = (schema.to_string(), table.to_string());
    let filtered = frag(filter).is_some();
    // Unfiltered big tables: the planner estimate, like estimatedDocumentCount.
    if !filtered {
        let estimate = read(conn, None, async |c| {
            let row = c
                .query_typed_opt(
                    "SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND c.relname = $2",
                    &[text(&s), text(&t)],
                )
                .await?;
            Ok(row.map(|r| r.get::<_, i64>(0)))
        })
        .await?;
        if let Some(n) = estimate.filter(|n| *n > 200_000) {
            return Ok(CountResult { count: Some(n as u64), exact: false, exec_ms: ms(started) });
        }
    }
    let sql = format!("SELECT count(*) FROM ({}) _q", select_sql(schema, table, filter, "", ""));
    let result = read(conn, Some(COUNT_TIMEOUT), async |c| match c.query_typed_one(&sql, &[]).await {
        Ok(row) => Ok(Some(row.get::<_, i64>(0) as u64)),
        Err(e) if is_timeout(&e) => Ok(None),
        Err(e) => Err(e.into()),
    })
    .await?;
    Ok(CountResult { exact: result.is_some(), count: result, exec_ms: ms(started) })
}

// ---------------------------------------------------------------------------
// writing rows
// ---------------------------------------------------------------------------

fn parse_object(text: &str) -> AppResult<Map<String, Value>> {
    let v: Value = match serde_json::from_str(text.trim()) {
        Ok(v) => v,
        // Fall back to the shell parser (unquoted keys, trailing commas, ...).
        Err(_) => crate::shell::parse_doc_or_empty(text)?,
    };
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(AppError::Parse("expected a row object like { \"column\": value }".into())),
    }
}

fn check_columns<'a>(meta: &TableMeta, keys: impl Iterator<Item = &'a String>) -> AppResult<()> {
    for k in keys {
        if meta.column(k).is_none() {
            return Err(AppError::Parse(format!("unknown column \"{k}\"")));
        }
    }
    Ok(())
}

fn require_editable(meta: &TableMeta, table: &str) -> AppResult<()> {
    if meta.editable() {
        Ok(())
    } else {
        Err(AppError::Other(format!("{table} is a {} - its rows can't be edited", meta.kind)))
    }
}

fn require_pk(meta: &TableMeta, table: &str) -> AppResult<()> {
    if meta.primary_key.is_empty() {
        return Err(AppError::Other(format!(
            "{table} has no primary key, so a single row can't be addressed - use Bulk update / delete or the SQL shell"
        )));
    }
    Ok(())
}

/// The row identity the UI sent, as a JSON object of primary key values. A
/// bare value is accepted for single-column keys.
fn key_object(meta: &TableMeta, id: &Value) -> AppResult<Value> {
    match id {
        Value::Object(m) => {
            for k in &meta.primary_key {
                if !m.contains_key(k) {
                    return Err(AppError::Parse(format!("row id is missing primary key column \"{k}\"")));
                }
            }
            Ok(id.clone())
        }
        other if meta.primary_key.len() == 1 => Ok(json!({ meta.primary_key[0].clone(): other })),
        _ => Err(AppError::Parse("row id must be an object of primary key values".into())),
    }
}

fn pk_of(meta: &TableMeta, row: &Value) -> Value {
    if meta.primary_key.is_empty() {
        return row.clone();
    }
    let mut m = Map::new();
    for k in &meta.primary_key {
        m.insert(k.clone(), row.get(k).cloned().unwrap_or(Value::Null));
    }
    Value::Object(m)
}

fn col_list(cols: &[String]) -> String {
    cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ")
}

/// `(pk1, pk2) = (SELECT pk1, pk2 FROM jsonb_populate_record(NULL::t, $n))`
fn pk_match(meta: &TableMeta, relname: &str, param: usize) -> String {
    let cols = col_list(&meta.primary_key);
    format!("({cols}) = (SELECT {cols} FROM jsonb_populate_record(NULL::{relname}, ${param}::jsonb))")
}

pub async fn insert(conn: &PgConn, schema: &str, table: &str, doc_text: &str) -> AppResult<Value> {
    let (s, t) = (schema.to_string(), table.to_string());
    let obj = parse_object(doc_text)?;
    write(conn, async |c| {
        let meta = meta_on(c, &s, &t).await?;
        require_editable(&meta, &t)?;
        check_columns(&meta, obj.keys())?;
        let relname = rel(&s, &t);
        let cols: Vec<String> = obj
            .keys()
            .filter(|k| meta.column(k).is_some_and(|c| !c.generated))
            .cloned()
            .collect();
        let overriding = cols
            .iter()
            .any(|k| meta.column(k).and_then(|c| c.identity.as_deref()) == Some("a"));
        let sql = if cols.is_empty() {
            format!("INSERT INTO {relname} DEFAULT VALUES RETURNING *")
        } else {
            let list = col_list(&cols);
            format!(
                "INSERT INTO {relname} ({list}){} SELECT {list} FROM jsonb_populate_record(NULL::{relname}, $1::jsonb) RETURNING *",
                if overriding { " OVERRIDING SYSTEM VALUE" } else { "" }
            )
        };
        let doc = Value::Object(obj.clone());
        let row = if cols.is_empty() {
            c.query_typed_one(&sql, &[]).await?
        } else {
            c.query_typed_one(&sql, &[jsonb(&doc)]).await?
        };
        Ok(json!({ "insertedId": pk_of(&meta, &row_to_json(&row)) }))
    })
    .await
}

pub async fn replace(conn: &PgConn, schema: &str, table: &str, id: &Value, doc_text: &str) -> AppResult<Value> {
    let (s, t) = (schema.to_string(), table.to_string());
    let obj = parse_object(doc_text)?;
    write(conn, async |c| {
        let meta = meta_on(c, &s, &t).await?;
        require_editable(&meta, &t)?;
        require_pk(&meta, &t)?;
        check_columns(&meta, obj.keys())?;
        let key = key_object(&meta, id)?;
        let relname = rel(&s, &t);
        // Only columns the row carries are written; generated and
        // always-identity columns can't be assigned.
        let cols: Vec<String> = obj
            .keys()
            .filter(|k| {
                meta.column(k)
                    .is_some_and(|c| !c.generated && c.identity.as_deref() != Some("a"))
            })
            .cloned()
            .collect();
        if cols.is_empty() {
            return Err(AppError::Parse("nothing to update".into()));
        }
        let list = col_list(&cols);
        let sql = format!(
            "UPDATE {relname} SET ({list}) = (SELECT {list} FROM jsonb_populate_record(NULL::{relname}, $1::jsonb)) WHERE {}",
            pk_match(&meta, &relname, 2)
        );
        let doc = Value::Object(obj.clone());
        let n = c.execute_typed(&sql, &[jsonb(&doc), jsonb(&key)]).await?;
        if n == 0 {
            return Err(AppError::Other("row not found (was it deleted, or its key changed?)".into()));
        }
        Ok(json!({ "matched": n, "modified": n }))
    })
    .await
}

pub async fn delete(conn: &PgConn, schema: &str, table: &str, id: &Value) -> AppResult<Value> {
    let (s, t) = (schema.to_string(), table.to_string());
    write(conn, async |c| {
        let meta = meta_on(c, &s, &t).await?;
        require_editable(&meta, &t)?;
        require_pk(&meta, &t)?;
        let key = key_object(&meta, id)?;
        let relname = rel(&s, &t);
        let sql = format!("DELETE FROM {relname} WHERE {}", pk_match(&meta, &relname, 1));
        let n = c.execute_typed(&sql, &[jsonb(&key)]).await?;
        Ok(json!({ "deleted": n }))
    })
    .await
}

pub async fn bulk_update(conn: &PgConn, schema: &str, table: &str, filter: &str, update: &str) -> AppResult<Value> {
    let set = frag(update).ok_or_else(|| AppError::Parse("a SET list is required, e.g. status = 'archived'".into()))?;
    // Accept "SET a = 1" as well as "a = 1".
    let set = match set.get(..4) {
        Some(p) if p.eq_ignore_ascii_case("set ") => set[4..].trim(),
        _ => set,
    };
    let mut sql = format!("UPDATE {} SET\n{set}\n", rel(schema, table));
    if let Some(f) = frag(filter) {
        sql.push_str(&format!("WHERE (\n{f}\n)"));
    }
    let started = Instant::now();
    let n = write(conn, async |c| Ok(c.execute_typed(&sql, &[]).await?)).await?;
    Ok(json!({ "matched": n, "modified": n, "execMs": ms(started) }))
}

pub async fn bulk_delete(conn: &PgConn, schema: &str, table: &str, filter: &str) -> AppResult<Value> {
    let f = frag(filter).ok_or_else(|| {
        AppError::Parse("bulk delete needs a WHERE condition - use Clear table to remove every row".into())
    })?;
    let sql = format!("DELETE FROM {} WHERE (\n{f}\n)", rel(schema, table));
    let started = Instant::now();
    let n = write(conn, async |c| Ok(c.execute_typed(&sql, &[]).await?)).await?;
    Ok(json!({ "deleted": n, "execMs": ms(started) }))
}

// ---------------------------------------------------------------------------
// table operations
// ---------------------------------------------------------------------------

pub async fn drop_table(conn: &PgConn, schema: &str, table: &str) -> AppResult<()> {
    let (s, t) = (schema.to_string(), table.to_string());
    write(conn, async |c| {
        let meta = meta_on(c, &s, &t).await?;
        let what = match meta.kind.as_str() {
            "view" => "VIEW",
            "matview" => "MATERIALIZED VIEW",
            "foreign" => "FOREIGN TABLE",
            _ => "TABLE",
        };
        c.batch_execute(&format!("DROP {what} {}", rel(&s, &t))).await?;
        Ok(())
    })
    .await
}

pub async fn clear_table(conn: &PgConn, schema: &str, table: &str) -> AppResult<u64> {
    // DELETE rather than TRUNCATE: it respects foreign keys (a clear error
    // instead of a cascade) and reports how many rows went.
    let sql = format!("DELETE FROM {}", rel(schema, table));
    write(conn, async |c| Ok(c.execute_typed(&sql, &[]).await?)).await
}

pub async fn duplicate_table(conn: &PgConn, schema: &str, source: &str, target: &str) -> AppResult<Value> {
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err(AppError::Parse("new table name is required".into()));
    }
    if target == source {
        return Err(AppError::Other("the new name must differ from the source".into()));
    }
    let (s, src) = (schema.to_string(), source.to_string());
    write(conn, async |c| {
        let exists = c
            .query_typed_one("SELECT to_regclass($1) IS NOT NULL", &[text(&rel(&s, &target))])
            .await?
            .get::<_, bool>(0);
        if exists {
            return Err(AppError::Other(format!("a table named '{target}' already exists")));
        }
        let meta = meta_on(c, &s, &src).await?;
        let (from, to) = (rel(&s, &src), rel(&s, &target));
        c.batch_execute(&format!("CREATE TABLE {to} (LIKE {from} INCLUDING ALL)")).await?;
        let cols: Vec<String> = meta.columns.iter().filter(|c| !c.generated).map(|c| c.name.clone()).collect();
        let list = col_list(&cols);
        let documents = c
            .execute_typed(&format!("INSERT INTO {to} ({list}) OVERRIDING SYSTEM VALUE SELECT {list} FROM {from}"), &[])
            .await?;
        let indexes = c
            .query_typed_one("SELECT count(*) FROM pg_index WHERE indrelid = $1::regclass AND NOT indisprimary", &[text(&to)])
            .await?
            .get::<_, i64>(0);
        Ok(json!({ "documents": documents, "indexes": indexes }))
    })
    .await
}

// ---------------------------------------------------------------------------
// stats & overview
// ---------------------------------------------------------------------------

const REL_STATS: &str = "
    CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE COALESCE(st.n_live_tup, 0) END,
    CASE WHEN c.relkind IN ('r','m','p','f') THEN pg_table_size(c.oid) END,
    CASE WHEN c.relkind IN ('r','m','p','f') THEN pg_total_relation_size(c.oid) END,
    CASE WHEN c.relkind IN ('r','m','p','f') THEN pg_indexes_size(c.oid) END,
    (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)";

pub async fn table_stats(conn: &PgConn, schema: &str, table: &str) -> AppResult<Value> {
    let (s, t) = (schema.to_string(), table.to_string());
    read(conn, None, async |c| {
        let row = c
            .query_typed_opt(
                &format!(
                    "SELECT {REL_STATS} FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
                     WHERE n.nspname = $1 AND c.relname = $2"
                ),
                &[text(&s), text(&t)],
            )
            .await?
            .ok_or_else(|| AppError::Other(format!("table {s}.{t} not found")))?;
        let count: i64 = row.get(0);
        let size: Option<i64> = row.get(1);
        Ok(json!({
            "count": count,
            "size": size,
            "avgObjSize": size.filter(|_| count > 0).map(|sz| sz / count.max(1)),
            "storageSize": row.get::<_, Option<i64>>(2),
            "totalIndexSize": row.get::<_, Option<i64>>(3),
            "nindexes": row.get::<_, i64>(4),
        }))
    })
    .await
}

pub async fn db_overview(conn: &PgConn, schema: &str) -> AppResult<DbOverview> {
    let s = schema.to_string();
    read(conn, None, async |c| {
        let rows = c
            .query_typed(
                &format!(
                    "SELECT c.relname::text, c.relkind::text, {REL_STATS},
                            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c')
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
                     WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
                     ORDER BY lower(c.relname)"
                ),
                &[text(&s)],
            )
            .await?;
        // Foreign keys are real references - no sampling or guessing needed.
        let fks = c
            .query_typed(
                "SELECT cl.relname::text,
                        array_to_string(ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(n, o)
                                              JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
                                              ORDER BY u.o), ', '),
                        rn.nspname::text, rc.relname::text
                 FROM pg_constraint k
                 JOIN pg_class cl ON cl.oid = k.conrelid
                 JOIN pg_namespace n ON n.oid = cl.relnamespace
                 JOIN pg_class rc ON rc.oid = k.confrelid
                 JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                 WHERE k.contype = 'f' AND n.nspname = $1",
                &[text(&s)],
            )
            .await?;
        let mut refs: HashMap<String, Vec<CollectionRef>> = HashMap::new();
        for r in &fks {
            let target_schema: String = r.get(2);
            let target: String = r.get(3);
            refs.entry(r.get(0)).or_default().push(CollectionRef {
                field: r.get(1),
                to: if target_schema == s { target } else { format!("{target_schema}.{target}") },
            });
        }
        let collections = rows
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let count: i64 = r.get(2);
                let size: Option<i64> = r.get(3);
                let kind = kind_name(&r.get::<_, String>(1));
                let is_view = matches!(kind, "view");
                CollectionOverview {
                    refs: refs.remove(&name).unwrap_or_default(),
                    name,
                    kind: kind.to_string(),
                    count: (!is_view).then_some(count),
                    size,
                    avg_obj_size: size.filter(|_| count > 0).map(|sz| sz / count.max(1)),
                    storage_size: r.get(4),
                    total_index_size: r.get(5),
                    nindexes: (!is_view).then(|| r.get(6)),
                    capped: false,
                    validated: r.get(7),
                }
            })
            .collect();
        Ok(DbOverview { database: s.clone(), collections, refs_skipped: 0 })
    })
    .await
}

// ---------------------------------------------------------------------------
// indexes
// ---------------------------------------------------------------------------

pub async fn list_indexes(conn: &PgConn, schema: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let (s, t) = (schema.to_string(), table.to_string());
    read(conn, None, async |c| {
        let since: Option<String> = c
            .query_typed_opt(
                "SELECT to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
                 FROM pg_stat_database WHERE datname = current_database()",
                &[],
            )
            .await?
            .and_then(|r| r.get(0));
        let rows = c
            .query_typed(
                "SELECT ic.relname::text, ix.indisunique, ix.indisprimary, am.amname::text,
                        pg_get_indexdef(ix.indexrelid), pg_get_expr(ix.indpred, ix.indrelid),
                        ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true)
                              FROM generate_series(1, ix.indnkeyatts) k ORDER BY k),
                        ix.indoption::int2[], s.idx_scan, pg_relation_size(ix.indexrelid), ix.indisvalid
                 FROM pg_index ix
                 JOIN pg_class ic ON ic.oid = ix.indexrelid
                 JOIN pg_class t ON t.oid = ix.indrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN pg_am am ON am.oid = ic.relam
                 LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
                 WHERE n.nspname = $1 AND t.relname = $2
                 ORDER BY ix.indisprimary DESC, ic.relname",
                &[text(&s), text(&t)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let method: String = r.get(3);
                let cols: Vec<String> = r.get(6);
                let opts: Vec<i16> = r.get(7);
                let mut keys = Map::new();
                for (i, col) in cols.into_iter().enumerate() {
                    let v = if method == "btree" {
                        json!(if opts.get(i).is_some_and(|o| o & 1 != 0) { -1 } else { 1 })
                    } else {
                        json!(method.clone())
                    };
                    keys.insert(col, v);
                }
                let valid: bool = r.get(10);
                IndexInfo {
                    name: r.get(0),
                    keys: Value::Object(keys),
                    unique: r.get(1),
                    sparse: false,
                    // An invalid index (failed CONCURRENTLY build) isn't used by the planner.
                    hidden: !valid,
                    ttl_seconds: None,
                    partial_filter: r.get::<_, Option<String>>(5).map(Value::String),
                    usage_ops: r.get(8),
                    usage_since: since.clone(),
                    primary: Some(r.get(2)),
                    method: Some(method),
                    definition: Some(r.get(4)),
                    size: Some(r.get(9)),
                }
            })
            .collect())
    })
    .await
}

/// Turn the index box into a column list. Takes SQL (`email, created_at DESC`,
/// `lower(email)`) or a MongoDB-style key document (`{ email: 1, at: -1 }`).
fn index_columns(keys_text: &str) -> AppResult<String> {
    let t = keys_text.trim();
    if t.starts_with('{') {
        let obj = parse_object(t)?;
        if obj.is_empty() {
            return Err(AppError::Parse("index columns are required".into()));
        }
        return Ok(obj
            .iter()
            .map(|(k, v)| {
                let desc = v.as_i64() == Some(-1);
                format!("{}{}", qi(k), if desc { " DESC" } else { "" })
            })
            .collect::<Vec<_>>()
            .join(", "));
    }
    let t = match t.strip_prefix('(').and_then(|x| x.strip_suffix(')')) {
        Some(inner) => inner.trim(),
        None => t,
    };
    if t.is_empty() {
        return Err(AppError::Parse("index columns are required, e.g. email or created_at DESC".into()));
    }
    Ok(t.to_string())
}

fn index_name(table: &str, cols: &str, unique: bool) -> String {
    let words: String = cols
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty() && !matches!(w.to_ascii_uppercase().as_str(), "DESC" | "ASC" | "NULLS" | "FIRST" | "LAST"))
        .collect::<Vec<_>>()
        .join("_");
    let mut name = format!("{table}_{words}_{}", if unique { "key" } else { "idx" });
    // Identifiers are capped at 63 bytes.
    while name.len() > 63 {
        name.remove(table.len().min(name.len() - 5));
    }
    name
}

#[allow(clippy::too_many_arguments)]
pub async fn create_index(
    conn: &PgConn,
    schema: &str,
    table: &str,
    keys_text: &str,
    name: Option<String>,
    unique: bool,
    method: Option<String>,
    predicate: Option<String>,
    concurrently: bool,
) -> AppResult<String> {
    let cols = index_columns(keys_text)?;
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| index_name(table, &cols, unique));
    let method = method.map(|m| m.trim().to_ascii_lowercase()).filter(|m| !m.is_empty() && m != "btree");
    if let Some(m) = &method {
        if !matches!(m.as_str(), "hash" | "gin" | "gist" | "brin" | "spgist" | "hnsw" | "ivfflat") {
            return Err(AppError::Parse(format!("unknown index method '{m}'")));
        }
    }
    let mut sql = format!(
        "CREATE {}INDEX {}{} ON {}{} (\n{cols}\n)",
        if unique { "UNIQUE " } else { "" },
        if concurrently { "CONCURRENTLY " } else { "" },
        qi(&name),
        rel(schema, table),
        method.map(|m| format!(" USING {m}")).unwrap_or_default(),
    );
    if let Some(p) = predicate.as_deref().and_then(frag) {
        sql.push_str(&format!(" WHERE (\n{p}\n)"));
    }
    if concurrently {
        // CONCURRENTLY can't run inside a transaction block.
        let client = conn.pool.get().await?;
        client.batch_execute(&sql).await?;
    } else {
        write(conn, async |c| Ok(c.batch_execute(&sql).await?)).await?;
    }
    Ok(name)
}

pub async fn drop_index(conn: &PgConn, schema: &str, name: &str) -> AppResult<()> {
    let target = rel(schema, name);
    write(conn, async |c| {
        // An index behind a UNIQUE / EXCLUDE constraint is dropped by dropping
        // the constraint; primary keys stay (that would change row identity).
        let owner = c
            .query_typed_opt(
                "SELECT k.contype::text, k.conname::text, t.relname::text
                 FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
                 WHERE k.conindid = $1::regclass",
                &[text(&target)],
            )
            .await?;
        match owner {
            Some(r) if r.get::<_, String>(0) == "p" => {
                Err(AppError::Other("this index backs the primary key - drop the key with ALTER TABLE in the SQL shell".into()))
            }
            Some(r) => {
                let (constraint, table): (String, String) = (r.get(1), r.get(2));
                c.batch_execute(&format!("ALTER TABLE {} DROP CONSTRAINT {}", rel(schema, &table), qi(&constraint)))
                    .await?;
                Ok(())
            }
            None => Ok(c.batch_execute(&format!("DROP INDEX {target}")).await?),
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

fn walk_plan(node: &Value, stages: &mut Vec<String>, index: &mut Option<String>, seq: &mut bool, examined: &mut i64) {
    let ty = node.get("Node Type").and_then(Value::as_str).unwrap_or("?");
    let label = match node.get("Relation Name").and_then(Value::as_str) {
        Some(r) => format!("{ty} on {r}"),
        None => ty.to_string(),
    };
    stages.push(label);
    if ty == "Seq Scan" {
        *seq = true;
    }
    if index.is_none() {
        if let Some(i) = node.get("Index Name").and_then(Value::as_str) {
            *index = Some(i.to_string());
        }
    }
    if ty.contains("Scan") {
        let loops = node.get("Actual Loops").and_then(Value::as_i64).unwrap_or(1).max(1);
        let rows = node.get("Actual Rows").and_then(Value::as_f64).unwrap_or(0.0) as i64;
        let removed = node.get("Rows Removed by Filter").and_then(Value::as_i64).unwrap_or(0);
        *examined += (rows + removed) * loops;
    }
    if let Some(Value::Array(children)) = node.get("Plans") {
        for child in children {
            walk_plan(child, stages, index, seq, examined);
        }
    }
}

/// Columns of the table named in the filter / sort, in order - a starting
/// point for an index when the plan is a sequential scan.
fn suggest_index(meta: &TableMeta, filter: &str, sort: &str) -> Option<Value> {
    let mut out = Map::new();
    for (text, is_sort) in [(filter, false), (sort, true)] {
        let code = super::sql::strip_comments_and_literals(text);
        let words: Vec<&str> = code
            .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '"'))
            .filter(|w| !w.is_empty())
            .collect();
        for (i, w) in words.iter().enumerate() {
            let name = w.trim_matches('"');
            if let Some(col) = meta.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name)) {
                if out.contains_key(&col.name) {
                    continue;
                }
                let desc = is_sort && words.get(i + 1).is_some_and(|n| n.eq_ignore_ascii_case("desc"));
                out.insert(col.name.clone(), json!(if desc { -1 } else { 1 }));
            }
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

#[allow(clippy::too_many_arguments)]
pub async fn explain(
    conn: &PgConn,
    schema: &str,
    table: &str,
    filter: &str,
    sort: &str,
    projection: &str,
    verbosity: &str,
    limit: Option<i64>,
) -> AppResult<Value> {
    let analyze = verbosity != "queryPlanner";
    let mut query = select_sql(schema, table, filter, sort, projection);
    if let Some(l) = limit {
        query.push_str(&format!("\nLIMIT {}", l.clamp(1, 100_000)));
    }
    let sql = format!(
        "EXPLAIN ({}FORMAT JSON) {query}",
        if analyze { "ANALYZE, BUFFERS, " } else { "" }
    );
    let (s, t) = (schema.to_string(), table.to_string());
    let (raw, meta) = read(conn, Some(Duration::from_secs(60)), async |c| {
        let row = c.query_typed_one(&sql, &[]).await?;
        let raw = row.get::<_, super::value::Cell>(0).0;
        Ok((raw, meta_on(c, &s, &t).await?))
    })
    .await?;
    let top = raw.get(0).cloned().unwrap_or(Value::Null);
    let plan = top.get("Plan").cloned().unwrap_or(Value::Null);
    let (mut stages, mut index, mut seq, mut examined) = (Vec::new(), None, false, 0i64);
    walk_plan(&plan, &mut stages, &mut index, &mut seq, &mut examined);
    let mut summary = json!({
        "indexName": index,
        "stages": stages,
        "isCollectionScan": seq,
        "nReturned": if analyze { plan.get("Actual Rows").and_then(Value::as_f64).map(|v| v as i64) } else { plan.get("Plan Rows").and_then(Value::as_f64).map(|v| v as i64) },
        "totalDocsExamined": analyze.then_some(examined),
        "totalKeysExamined": Value::Null,
        "executionTimeMillis": top.get("Execution Time").and_then(Value::as_f64).map(|v| v.round() as i64),
        "planningTimeMillis": top.get("Planning Time").and_then(Value::as_f64),
        "totalCost": plan.get("Total Cost"),
        "raw": top,
    });
    if seq {
        if let Some(idx) = suggest_index(&meta, filter, sort) {
            summary["suggestedIndex"] = idx;
        }
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------
// schema analysis & fields
// ---------------------------------------------------------------------------

pub async fn fields(conn: &PgConn, schema: &str, table: &str) -> AppResult<Vec<String>> {
    Ok(table_meta(conn, schema, table).await?.columns.into_iter().map(|c| c.name).collect())
}

/// Sample SQL: a TABLESAMPLE for big tables so the sample isn't just the
/// first pages on disk, a plain LIMIT otherwise.
fn sample_sql(relname: &str, estimate: i64, size: i64) -> String {
    if estimate > size * 20 {
        let pct = ((size as f64 * 300.0) / estimate as f64).clamp(0.01, 100.0);
        format!("SELECT * FROM {relname} TABLESAMPLE SYSTEM ({pct:.4}) LIMIT {size}")
    } else {
        format!("SELECT * FROM {relname} LIMIT {size}")
    }
}

fn json_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "double",
        Value::Number(_) => "int",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub async fn analyze_schema(conn: &PgConn, schema: &str, table: &str, sample_size: i64) -> AppResult<Value> {
    let (s, t) = (schema.to_string(), table.to_string());
    let size = sample_size.clamp(10, 10_000);
    read(conn, Some(Duration::from_secs(30)), async |c| {
        let meta = meta_on(c, &s, &t).await?;
        let estimate = c
            .query_typed_one("SELECT GREATEST(reltuples, 0)::bigint FROM pg_class WHERE oid = $1::regclass", &[text(&rel(&s, &t))])
            .await?
            .get::<_, i64>(0);
        let (rows, _, _) = collect_rows(c, &sample_sql(&rel(&s, &t), estimate, size), &[], size as usize).await?;
        let sampled = rows.len() as i64;

        struct Acc {
            present: i64,
            types: BTreeMap<String, i64>,
            examples: Vec<Value>,
        }
        let mut accs: Vec<(String, Acc)> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut slot = |path: &str, accs: &mut Vec<(String, Acc)>| -> usize {
            *index.entry(path.to_string()).or_insert_with(|| {
                accs.push((path.to_string(), Acc { present: 0, types: BTreeMap::new(), examples: Vec::new() }));
                accs.len() - 1
            })
        };
        // Columns first, in table order, so the report reads like the table.
        for col in &meta.columns {
            slot(&col.name, &mut accs);
        }
        type Slot<'a> = dyn FnMut(&str, &mut Vec<(String, Acc)>) -> usize + 'a;
        fn visit_json(prefix: &str, v: &Map<String, Value>, accs: &mut Vec<(String, Acc)>, slot: &mut Slot<'_>) {
            for (k, v) in v {
                let path = format!("{prefix}.{k}");
                let i = slot(&path, accs);
                let acc = &mut accs[i].1;
                if !v.is_null() {
                    acc.present += 1;
                }
                *acc.types.entry(json_type(v).to_string()).or_insert(0) += 1;
                if acc.examples.len() < 3 && !v.is_null() && !v.is_object() && !v.is_array() {
                    acc.examples.push(v.clone());
                }
                if let Value::Object(sub) = v {
                    visit_json(&path, sub, accs, slot);
                }
            }
        }
        for row in &rows {
            for col in &meta.columns {
                let v = row.get(&col.name).cloned().unwrap_or(Value::Null);
                let i = slot(&col.name, &mut accs);
                let acc = &mut accs[i].1;
                let ty = if v.is_null() { "null".to_string() } else { col.data_type.clone() };
                *acc.types.entry(ty).or_insert(0) += 1;
                if !v.is_null() {
                    acc.present += 1;
                    if acc.examples.len() < 3 && !acc.examples.contains(&v) {
                        let ex = match &v {
                            Value::String(sv) if sv.chars().count() > 120 => {
                                Value::String(format!("{}…", sv.chars().take(120).collect::<String>()))
                            }
                            Value::Object(_) | Value::Array(_) => {
                                let text = v.to_string();
                                Value::String(if text.chars().count() > 120 {
                                    format!("{}…", text.chars().take(120).collect::<String>())
                                } else {
                                    text
                                })
                            }
                            other => other.clone(),
                        };
                        acc.examples.push(ex);
                    }
                }
                // json / jsonb columns: report nested paths too.
                if let Value::Object(obj) = &v {
                    if col.data_type.starts_with("json") {
                        visit_json(&col.name, obj, &mut accs, &mut slot);
                    }
                }
            }
        }
        let fields: Vec<Value> = accs
            .into_iter()
            .map(|(path, acc)| {
                let mut types: Vec<Value> = acc.types.into_iter().map(|(t, n)| json!({ "type": t, "count": n })).collect();
                types.sort_by_key(|v| -(v.get("count").and_then(Value::as_i64).unwrap_or(0)));
                let col = meta.column(&path);
                json!({
                    "path": path,
                    "present": acc.present,
                    "coverage": if sampled > 0 { acc.present as f64 / sampled as f64 } else { 0.0 },
                    "types": types,
                    "examples": acc.examples,
                    "dataType": col.map(|c| c.data_type.clone()),
                    "nullable": col.map(|c| c.nullable),
                    "default": col.and_then(|c| c.default.clone()),
                    "primaryKey": col.map(|c| meta.primary_key.contains(&c.name)),
                })
            })
            .collect();
        Ok(json!({ "sampled": sampled, "fields": fields, "primaryKey": meta.primary_key, "kind": meta.kind }))
    })
    .await
}

// ---------------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------------

/// Stream rows of `query` through a server-side cursor, `BATCH` at a time.
/// `each` returns `false` to stop early. Returns whether it was stopped.
async fn cursor_rows(
    client: &PgClient,
    query: &str,
    cancel: &AtomicBool,
    mut each: impl FnMut(Vec<Value>, Vec<String>) -> AppResult<bool>,
) -> AppResult<bool> {
    client.batch_execute(&format!("DECLARE _mb_cursor NO SCROLL CURSOR FOR {query}")).await?;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(true);
        }
        let rows = client.query_typed(&format!("FETCH {BATCH} FROM _mb_cursor"), &[]).await?;
        if rows.is_empty() {
            return Ok(false);
        }
        let cols = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
        let done = rows.len() < BATCH;
        if !each(rows.iter().map(row_to_json).collect(), cols)? {
            return Ok(true);
        }
        if done {
            return Ok(false);
        }
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn csv_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn export(
    conn: &PgConn,
    schema: &str,
    table: &str,
    filter: &str,
    sort: &str,
    format: &str,
    path: &str,
    cancel: &AtomicBool,
    emit: &(dyn Fn(u64, Option<u64>) + Sync),
) -> AppResult<(u64, bool, bool)> {
    use std::io::Write;
    if format == "bson" {
        return Err(AppError::Other("BSON export is only available for MongoDB - pick JSON, NDJSON, CSV or a spreadsheet".into()));
    }
    let total = count(conn, schema, table, filter).await.ok().and_then(|c| c.count);
    let query = select_sql(schema, table, filter, sort, "");
    if crate::sheet::is_sheet_format(format) {
        return export_sheet(conn, table, &query, format, path, total, cancel, emit).await;
    }
    let file = std::fs::File::create(path).map_err(|e| AppError::Parse(format!("cannot write {path}: {e}")))?;
    let mut w = std::io::BufWriter::new(file);
    let mut count_written: u64 = 0;
    let format = format.to_string();
    let canceled = read(conn, None, async |c| {
        let mut header_done = false;
        if format == "json" {
            w.write_all(b"[\n")?;
        }
        let stopped = cursor_rows(c, &query, cancel, |rows, cols| {
            for row in rows {
                match format.as_str() {
                    "csv" => {
                        if !header_done {
                            writeln!(w, "{}", cols.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","))?;
                            header_done = true;
                        }
                        let cells: Vec<String> = cols.iter().map(|k| csv_escape(&csv_cell(row.get(k).unwrap_or(&Value::Null)))).collect();
                        writeln!(w, "{}", cells.join(","))?;
                    }
                    "ndjson" => writeln!(w, "{row}")?,
                    _ => {
                        if count_written > 0 {
                            w.write_all(b",\n")?;
                        }
                        w.write_all(serde_json::to_string_pretty(&row)?.as_bytes())?;
                    }
                }
                count_written += 1;
            }
            emit(count_written, total);
            Ok(true)
        })
        .await?;
        if format == "json" {
            w.write_all(b"\n]")?;
        }
        w.flush()?;
        Ok(stopped)
    })
    .await?;
    emit(count_written, total);
    Ok((count_written, canceled, false))
}

/// `.xlsx` / `.numbers` export: rows stream from a cursor into the sheet in
/// table column order. Returns (rows, canceled, cut short by the row limit).
#[allow(clippy::too_many_arguments)]
async fn export_sheet(
    conn: &PgConn,
    table: &str,
    query: &str,
    format: &str,
    path: &str,
    total: Option<u64>,
    cancel: &AtomicBool,
    emit: &(dyn Fn(u64, Option<u64>) + Sync),
) -> AppResult<(u64, bool, bool)> {
    use crate::sheet;
    if format == "numbers" && !sheet::numbers_available() {
        return Err(AppError::Other(sheet::NUMBERS_MISSING.into()));
    }
    let dest = std::path::PathBuf::from(path);
    let staged = sheet::staging_path(format, &dest);
    let limit = sheet::max_rows(format);
    let mut writer: Option<sheet::SheetWriter> = None;
    let mut written = 0u64;
    let mut full = false;
    let result = read(conn, None, async |c| {
        let stopped = cursor_rows(c, query, cancel, |rows, cols| {
            let w = match writer.as_mut() {
                Some(w) => w,
                None => writer.insert(sheet::SheetWriter::new(cols, table, limit)?),
            };
            for row in rows {
                if let Value::Object(m) = row {
                    if !w.push(&m)? {
                        full = true;
                        return Ok(false);
                    }
                    written += 1;
                }
            }
            emit(written, total);
            Ok(true)
        })
        .await?;
        Ok(stopped && !full)
    })
    .await;
    let canceled = match result {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    // An empty result still gets a header-only sheet.
    let w = match writer {
        Some(w) => w,
        None => sheet::SheetWriter::new(Vec::new(), table, limit)?,
    };
    let fmt = format.to_string();
    let (written, truncated) = tokio::task::spawn_blocking(move || -> AppResult<(u64, bool)> {
        let out = w.save(&staged);
        match out {
            Ok(out) => {
                sheet::finish(&fmt, &staged, &dest)?;
                Ok(out)
            }
            Err(e) => {
                if staged != dest {
                    let _ = std::fs::remove_file(&staged);
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    emit(written, total);
    Ok((written, canceled, truncated))
}

/// Insert JSON rows in one statement. Columns are the union of keys across the
/// batch; keys that aren't columns are an error, not silently dropped.
async fn insert_rows(client: &PgClient, relname: &str, meta: &TableMeta, rows: &[Value], upsert: bool) -> AppResult<u64> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut cols: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for r in rows {
        if let Value::Object(m) = r {
            for k in m.keys() {
                if seen.insert(k.clone()) {
                    if meta.column(k).is_none() {
                        return Err(AppError::Parse(format!("unknown column \"{k}\"")));
                    }
                    if !meta.column(k).is_some_and(|c| c.generated) {
                        cols.push(k.clone());
                    }
                }
            }
        }
    }
    if cols.is_empty() {
        return Ok(0);
    }
    let list = col_list(&cols);
    let overriding = cols.iter().any(|k| meta.column(k).and_then(|c| c.identity.as_deref()) == Some("a"));
    let mut sql = format!(
        "INSERT INTO {relname} ({list}){} SELECT {list} FROM jsonb_populate_recordset(NULL::{relname}, $1::jsonb)",
        if overriding { " OVERRIDING SYSTEM VALUE" } else { "" }
    );
    if upsert && !meta.primary_key.is_empty() {
        let updates: Vec<String> = cols
            .iter()
            .filter(|c| !meta.primary_key.contains(c) && meta.column(c).and_then(|m| m.identity.as_deref()) != Some("a"))
            .map(|c| format!("{} = EXCLUDED.{}", qi(c), qi(c)))
            .collect();
        sql.push_str(&format!(" ON CONFLICT ({}) DO ", col_list(&meta.primary_key)));
        if updates.is_empty() {
            sql.push_str("NOTHING");
        } else {
            sql.push_str(&format!("UPDATE SET {}", updates.join(", ")));
        }
    }
    let payload = Value::Array(rows.to_vec());
    Ok(client.execute_typed(&sql, &[jsonb(&payload)]).await?)
}

/// Read an import file into row objects (JSON array, NDJSON or CSV).
fn read_import_file(path: &str) -> AppResult<Vec<Value>> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let text = std::fs::read_to_string(path).map_err(|e| AppError::Parse(format!("cannot read {path}: {e}")))?;
    let rows: Vec<Value> = match ext.as_str() {
        "bson" => return Err(AppError::Other("BSON files can only be imported into MongoDB".into())),
        "csv" => {
            let rows = crate::commands::parse_csv(&text)?;
            let mut iter = rows.into_iter();
            let header = iter.next().ok_or_else(|| AppError::Parse("CSV file is empty".into()))?;
            iter.filter(|r| !r.iter().all(|c| c.is_empty()))
                .map(|r| {
                    let mut m = Map::new();
                    for (i, cell) in r.into_iter().enumerate() {
                        let Some(key) = header.get(i).filter(|k| !k.is_empty()) else { continue };
                        // Empty cell → column default; values stay text and
                        // Postgres parses them with each column's input function.
                        if cell.is_empty() {
                            continue;
                        }
                        // Arrays / objects were exported as JSON text.
                        let parsed = if cell.starts_with(['[', '{']) { serde_json::from_str(&cell).ok() } else { None };
                        m.insert(key.clone(), parsed.unwrap_or(Value::String(cell)));
                    }
                    Value::Object(m)
                })
                .collect()
        }
        _ if text.trim_start().starts_with('[') => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(a)) => a,
            _ => match crate::shell::parse_value(&text)? {
                Value::Array(a) => a,
                _ => return Err(AppError::Parse("expected a JSON array".into())),
            },
        },
        _ => text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| {
                serde_json::from_str(l)
                    .or_else(|_| crate::shell::parse_value(l))
                    .map_err(|e| AppError::Parse(format!("line {}: {e}", i + 1)))
            })
            .collect::<AppResult<_>>()?,
    };
    if let Some(bad) = rows.iter().position(|r| !r.is_object()) {
        return Err(AppError::Parse(format!("record {} is not an object", bad + 1)));
    }
    Ok(rows)
}

pub async fn import(
    conn: &PgConn,
    schema: &str,
    table: &str,
    path: &str,
    cancel: &AtomicBool,
    emit: &(dyn Fn(u64) + Sync),
) -> AppResult<(u64, bool)> {
    let rows = read_import_file(path)?;
    if rows.is_empty() {
        return Err(AppError::Parse("no rows found in file".into()));
    }
    let meta = table_meta(conn, schema, table).await?;
    require_editable(&meta, table)?;
    let relname = rel(schema, table);
    let mut count = 0u64;
    let mut canceled = false;
    for chunk in rows.chunks(BATCH) {
        if cancel.load(Ordering::Relaxed) {
            canceled = true;
            break;
        }
        count += write(conn, async |c| insert_rows(c, &relname, &meta, chunk, false).await).await?;
        emit(count);
    }
    Ok((count, canceled))
}

// ---------------------------------------------------------------------------
// copy / diff / sync between Postgres workspaces
// ---------------------------------------------------------------------------

/// Column definitions for recreating a table elsewhere: types and NOT NULL
/// plus the primary key. Defaults are left out - they usually reference
/// sequences that don't exist on the target.
fn create_table_sql(relname: &str, meta: &TableMeta) -> String {
    let mut defs: Vec<String> = meta
        .columns
        .iter()
        .map(|c| format!("{} {}{}", qi(&c.name), c.data_type, if c.nullable { "" } else { " NOT NULL" }))
        .collect();
    if !meta.primary_key.is_empty() {
        defs.push(format!("PRIMARY KEY ({})", col_list(&meta.primary_key)));
    }
    format!("CREATE TABLE {relname} (\n  {}\n)", defs.join(",\n  "))
}

/// Rewrite an index definition to point at another table under a new name.
fn retarget_index(def: &str, new_name: &str, target_rel: &str) -> Option<String> {
    let using = def.find(" USING ")?;
    let unique = def.starts_with("CREATE UNIQUE");
    Some(format!(
        "CREATE {}INDEX {} ON {target_rel}{}",
        if unique { "UNIQUE " } else { "" },
        qi(new_name),
        &def[using..]
    ))
}

#[allow(clippy::too_many_arguments)]
pub async fn copy_table(
    src: &PgConn,
    dst: &PgConn,
    src_schema: &str,
    src_table: &str,
    dst_schema: &str,
    dst_table: &str,
    filter: &str,
    copy_indexes: bool,
    cancel: &AtomicBool,
    emit: &(dyn Fn(u64, Option<u64>) + Sync),
) -> AppResult<CopyOutcome> {
    let started = Instant::now();
    let meta = table_meta(src, src_schema, src_table).await?;
    let target_rel = rel(dst_schema, dst_table);
    let (ds, dt) = (dst_schema.to_string(), dst_table.to_string());
    write(dst, async |c| {
        let exists = c
            .query_typed_one("SELECT to_regclass($1) IS NOT NULL", &[text(&target_rel)])
            .await?
            .get::<_, bool>(0);
        if exists {
            return Err(AppError::Other(format!("table '{dt}' already exists in schema '{ds}' on the target")));
        }
        c.batch_execute(&format!("CREATE SCHEMA IF NOT EXISTS {}", qi(&ds))).await?;
        c.batch_execute(&create_table_sql(&target_rel, &meta)).await?;
        Ok(())
    })
    .await?;
    let target_meta = table_meta(dst, dst_schema, dst_table).await?;

    let total = count(src, src_schema, src_table, filter).await.ok().and_then(|c| c.count);
    let query = select_sql(src_schema, src_table, filter, "", "");
    let mut copied = 0u64;
    // Read a batch on the source, write it on the target, repeat. The cursor
    // lives in the source's read-only transaction; each write commits.
    let canceled = read(src, None, async |c| {
        c.batch_execute(&format!("DECLARE _mb_cursor NO SCROLL CURSOR FOR {query}")).await?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(true);
            }
            let rows = c.query_typed(&format!("FETCH {BATCH} FROM _mb_cursor"), &[]).await?;
            if rows.is_empty() {
                return Ok(false);
            }
            let batch: Vec<Value> = rows.iter().map(row_to_json).collect();
            let n = write(dst, async |w| insert_rows(w, &target_rel, &target_meta, &batch, false).await).await?;
            copied += n;
            emit(copied, total);
            if rows.len() < BATCH {
                return Ok(false);
            }
        }
    })
    .await?;

    let mut indexes = 0u32;
    if copy_indexes && !canceled {
        let defs = list_indexes(src, src_schema, src_table).await?;
        for (i, idx) in defs.iter().filter(|x| x.primary != Some(true)).enumerate() {
            let Some(def) = &idx.definition else { continue };
            let name = index_name(dst_table, &format!("{i}"), idx.unique);
            let name = if idx.name.starts_with(src_table) {
                format!("{dst_table}{}", &idx.name[src_table.len()..])
            } else {
                name
            };
            if let Some(sql) = retarget_index(def, &name, &target_rel) {
                write(dst, async |c| Ok(c.batch_execute(&sql).await?)).await?;
                indexes += 1;
            }
        }
    }
    Ok(CopyOutcome { documents: copied, indexes, canceled, truncated: false, exec_ms: ms(started) })
}

fn key_string(meta: &TableMeta, row: &Value) -> String {
    pk_of(meta, row).to_string()
}

#[allow(clippy::too_many_arguments)]
pub async fn diff_tables(
    src: &PgConn,
    dst: &PgConn,
    src_schema: &str,
    src_table: &str,
    dst_schema: &str,
    dst_table: &str,
    filter: &str,
    cancel: &AtomicBool,
    emit: &(dyn Fn(&str, u64, Option<u64>) + Sync),
) -> AppResult<DiffOutcome> {
    let meta = table_meta(src, src_schema, src_table).await?;
    let tmeta = table_meta(dst, dst_schema, dst_table).await?;
    if meta.primary_key.is_empty() {
        return Err(AppError::Other(format!("{src_table} has no primary key - rows can't be matched across tables")));
    }
    if tmeta.primary_key != meta.primary_key {
        return Err(AppError::Other("the two tables have different primary keys".into()));
    }
    let mut out = DiffOutcome {
        identical: 0,
        changed: 0,
        only_in_source: 0,
        only_in_target: 0,
        changed_docs: Vec::new(),
        only_in_source_docs: Vec::new(),
        only_in_target_docs: Vec::new(),
        truncated: false,
        canceled: false,
        exec_ms: 0,
    };
    let src_total = count(src, src_schema, src_table, filter).await.ok().and_then(|c| c.count);
    let dst_total = count(dst, dst_schema, dst_table, filter).await.ok().and_then(|c| c.count);
    let (src_rel, dst_rel) = (rel(src_schema, src_table), rel(dst_schema, dst_table));
    let pk_cols = col_list(&meta.primary_key);
    let lookup = |relname: &str, cols: &str| {
        format!(
            "SELECT {cols} FROM {relname} WHERE ({pk_cols}) IN (SELECT {pk_cols} FROM jsonb_populate_recordset(NULL::{relname}, $1::jsonb))"
        )
    };

    // Pass 1: source rows, looked up on the target by primary key.
    let q1 = select_sql(src_schema, src_table, filter, "", "");
    let find_target = lookup(&dst_rel, "*");
    let mut processed = 0u64;
    out.canceled = read(src, None, async |c| {
        c.batch_execute(&format!("DECLARE _mb_cursor NO SCROLL CURSOR FOR {q1}")).await?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(true);
            }
            let rows = c.query_typed(&format!("FETCH {BATCH} FROM _mb_cursor"), &[]).await?;
            if rows.is_empty() {
                return Ok(false);
            }
            let batch: Vec<Value> = rows.iter().map(row_to_json).collect();
            let keys = Value::Array(batch.iter().map(|r| pk_of(&meta, r)).collect());
            let found = read(dst, None, async |d| {
                let (rows, _, _) = collect_rows(d, &find_target, &[jsonb(&keys)], usize::MAX).await?;
                Ok(rows)
            })
            .await?;
            let mut by_key: HashMap<String, Value> = found.into_iter().map(|r| (key_string(&meta, &r), r)).collect();
            for srow in batch {
                let id = pk_of(&meta, &srow);
                match by_key.remove(&id.to_string()) {
                    None => {
                        out.only_in_source += 1;
                        if out.only_in_source_docs.len() < DIFF_DETAIL_CAP {
                            out.only_in_source_docs.push(DiffEntry { id, source: Some(srow), target: None });
                        } else {
                            out.truncated = true;
                        }
                    }
                    Some(trow) if trow == srow => out.identical += 1,
                    Some(trow) => {
                        out.changed += 1;
                        if out.changed_docs.len() < DIFF_DETAIL_CAP {
                            out.changed_docs.push(DiffEntry { id, source: Some(srow), target: Some(trow) });
                        } else {
                            out.truncated = true;
                        }
                    }
                }
                processed += 1;
            }
            emit("source", processed, src_total);
            if rows.len() < BATCH {
                return Ok(false);
            }
        }
    })
    .await?;
    if out.canceled {
        return Ok(out);
    }

    // Pass 2: target rows whose key is missing on the source.
    let q2 = select_sql(dst_schema, dst_table, filter, "", "");
    let find_source = lookup(&src_rel, &pk_cols);
    let mut processed = 0u64;
    out.canceled = read(dst, None, async |c| {
        c.batch_execute(&format!("DECLARE _mb_cursor NO SCROLL CURSOR FOR {q2}")).await?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(true);
            }
            let rows = c.query_typed(&format!("FETCH {BATCH} FROM _mb_cursor"), &[]).await?;
            if rows.is_empty() {
                return Ok(false);
            }
            let batch: Vec<Value> = rows.iter().map(row_to_json).collect();
            let keys = Value::Array(batch.iter().map(|r| pk_of(&meta, r)).collect());
            let present: HashSet<String> = read(src, None, async |s| {
                let (rows, _, _) = collect_rows(s, &find_source, &[jsonb(&keys)], usize::MAX).await?;
                Ok(rows.iter().map(|r| key_string(&meta, r)).collect())
            })
            .await?;
            for trow in batch {
                let id = pk_of(&meta, &trow);
                if !present.contains(&id.to_string()) {
                    out.only_in_target += 1;
                    if out.only_in_target_docs.len() < DIFF_DETAIL_CAP {
                        out.only_in_target_docs.push(DiffEntry { id, source: None, target: Some(trow) });
                    } else {
                        out.truncated = true;
                    }
                }
                processed += 1;
            }
            emit("target", processed, dst_total);
            if rows.len() < BATCH {
                return Ok(false);
            }
        }
    })
    .await?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub async fn sync_rows(
    src: &PgConn,
    dst: &PgConn,
    src_schema: &str,
    src_table: &str,
    dst_schema: &str,
    dst_table: &str,
    action: &str,
    ids: &[Value],
) -> AppResult<u64> {
    let meta = table_meta(dst, dst_schema, dst_table).await?;
    require_pk(&meta, dst_table)?;
    let (src_rel, dst_rel) = (rel(src_schema, src_table), rel(dst_schema, dst_table));
    let pk_cols = col_list(&meta.primary_key);
    let mut applied = 0u64;
    for chunk in ids.chunks(BATCH) {
        let keys = Value::Array(chunk.iter().map(|id| key_object(&meta, id)).collect::<AppResult<_>>()?);
        match action {
            "copy" => {
                let sql = format!(
                    "SELECT * FROM {src_rel} WHERE ({pk_cols}) IN (SELECT {pk_cols} FROM jsonb_populate_recordset(NULL::{src_rel}, $1::jsonb))"
                );
                let rows = read(src, None, async |c| Ok(collect_rows(c, &sql, &[jsonb(&keys)], usize::MAX).await?.0)).await?;
                applied += write(dst, async |c| insert_rows(c, &dst_rel, &meta, &rows, true).await).await?;
            }
            "delete" => {
                let sql = format!(
                    "DELETE FROM {dst_rel} WHERE ({pk_cols}) IN (SELECT {pk_cols} FROM jsonb_populate_recordset(NULL::{dst_rel}, $1::jsonb))"
                );
                applied += write(dst, async |c| Ok(c.execute_typed(&sql, &[jsonb(&keys)]).await?)).await?;
            }
            other => return Err(AppError::Parse(format!("unknown sync action '{other}'"))),
        }
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------
// ops panel
// ---------------------------------------------------------------------------

/// Active backends from pg_stat_activity, shaped like MongoDB's currentOp so
/// the ops panel can show both (`opid`, `secs_running`, `ns`, `command`...).
pub async fn current_ops(conn: &PgConn) -> AppResult<Vec<Value>> {
    read(conn, None, async |c| {
        let rows = c
            .query_typed(
                "SELECT pid, usename::text, datname::text, application_name, client_addr::text, state,
                        wait_event_type, wait_event, query, backend_type,
                        EXTRACT(EPOCH FROM now() - query_start)::float8,
                        EXTRACT(EPOCH FROM now() - xact_start)::float8
                 FROM pg_stat_activity
                 WHERE pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
                   AND backend_type = 'client backend'
                 ORDER BY query_start NULLS LAST",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let secs: Option<f64> = r.get(10);
                json!({
                    "opid": r.get::<_, i32>(0),
                    "pid": r.get::<_, i32>(0),
                    "user": r.get::<_, Option<String>>(1),
                    "ns": r.get::<_, Option<String>>(2),
                    "appName": r.get::<_, Option<String>>(3),
                    "client": r.get::<_, Option<String>>(4),
                    "op": r.get::<_, Option<String>>(5),
                    "state": r.get::<_, Option<String>>(5),
                    "waitingForLock": r.get::<_, Option<String>>(6).as_deref() == Some("Lock"),
                    "waitEvent": match (r.get::<_, Option<String>>(6), r.get::<_, Option<String>>(7)) {
                        (Some(t), Some(e)) => Some(format!("{t}: {e}")),
                        _ => None,
                    },
                    "command": { "query": r.get::<_, Option<String>>(8) },
                    "query": r.get::<_, Option<String>>(8),
                    "desc": r.get::<_, Option<String>>(9),
                    "secs_running": secs.map(|s| s.floor() as i64),
                    "microsecs_running": secs.map(|s| (s * 1e6) as i64),
                    "xactSecs": r.get::<_, Option<f64>>(11),
                })
            })
            .collect())
    })
    .await
}

/// Cancel a backend's running query (`pg_cancel_backend`, the killOp
/// equivalent); `terminate` closes its connection instead.
pub async fn kill_op(conn: &PgConn, op: &Value) -> AppResult<()> {
    let (pid, terminate) = match op {
        Value::Object(m) => (
            m.get("pid").and_then(Value::as_i64),
            m.get("terminate").and_then(Value::as_bool).unwrap_or(false),
        ),
        v => (v.as_i64(), false),
    };
    let pid = pid.ok_or_else(|| AppError::Parse("expected a backend pid".into()))? as i32;
    let f = if terminate { "pg_terminate_backend" } else { "pg_cancel_backend" };
    let client = conn.pool.get().await?;
    let ok: bool = client
        .query_typed_one(&format!("SELECT {f}($1)"), &[(&pid as &(dyn ToSql + Sync), Type::INT4)])
        .await?
        .get(0);
    if !ok {
        return Err(AppError::Other(format!("backend {pid} is gone or not yours to signal")));
    }
    Ok(())
}

/// pg_stat_statements plays the profiler's role for Postgres.
pub async fn stat_statements_status(conn: &PgConn) -> AppResult<Value> {
    read(conn, None, async |c| {
        let row = c
            .query_typed_one(
                "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'),
                        EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements'),
                        current_setting('shared_preload_libraries', true)",
                &[],
            )
            .await?;
        let installed: bool = row.get(0);
        let preload: Option<String> = row.get(2);
        let loaded = preload.as_deref().unwrap_or("").contains("pg_stat_statements");
        Ok(json!({
            "engine": "postgres",
            "was": if installed && loaded { 1 } else { 0 },
            "installed": installed,
            "available": row.get::<_, bool>(1),
            "preloaded": loaded,
        }))
    })
    .await
}

/// level 1 installs pg_stat_statements; level 0 resets its counters.
pub async fn set_stat_statements(conn: &PgConn, level: i32) -> AppResult<Value> {
    let sql = if level > 0 {
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
    } else {
        "SELECT pg_stat_statements_reset()"
    };
    write(conn, async |c| Ok(c.batch_execute(sql).await?)).await?;
    stat_statements_status(conn).await
}

pub async fn stat_statements(conn: &PgConn, limit: i64) -> AppResult<Vec<Value>> {
    let limit = limit.clamp(1, 500);
    read(conn, None, async |c| {
        // Column names changed in Postgres 13 (total_time -> total_exec_time).
        let modern = format!(
            "SELECT query, calls, total_exec_time, mean_exec_time, max_exec_time, rows,
                    shared_blks_hit, shared_blks_read
             FROM pg_stat_statements
             WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
             ORDER BY total_exec_time DESC LIMIT {limit}"
        );
        let rows = match c.query_typed(&modern, &[]).await {
            Ok(rows) => rows,
            Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNDEFINED_COLUMN) => {
                c.batch_execute("ROLLBACK; BEGIN READ ONLY").await?;
                c.query_typed(&modern.replace("_exec_time", "_time"), &[]).await?
            }
            Err(e) => return Err(e.into()),
        };
        Ok(rows.iter().map(row_to_json).collect())
    })
    .await
}

pub async fn server_status_light(conn: &PgConn) -> AppResult<Value> {
    read(conn, None, async |c| {
        let r = c
            .query_typed_one(
                "SELECT (SELECT count(*) FROM pg_stat_activity)::bigint,
                        current_setting('max_connections')::bigint,
                        (SELECT count(*) FROM pg_stat_activity WHERE state = 'active')::bigint,
                        d.xact_commit, d.xact_rollback, d.tup_returned, d.tup_fetched,
                        d.tup_inserted, d.tup_updated, d.tup_deleted, d.blks_read, d.blks_hit,
                        EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint,
                        current_setting('server_version'),
                        pg_database_size(current_database())
                 FROM pg_stat_database d WHERE d.datname = current_database()",
                &[],
            )
            .await?;
        let g = |i: usize| r.get::<_, i64>(i);
        let (current, max) = (g(0), g(1));
        Ok(json!({
            "engine": "postgres",
            "uptime": g(12),
            "version": r.get::<_, String>(13),
            // Mongo-shaped counters so the live chart works unchanged:
            // "query" counts rows read, "command" counts transactions.
            "opcounters": {
                "insert": g(7),
                "query": g(6),
                "update": g(8),
                "delete": g(9),
                "getmore": 0,
                "command": g(3) + g(4),
            },
            "connections": { "current": current, "available": (max - current).max(0), "active": g(2) },
            "pg": {
                "xactCommit": g(3),
                "xactRollback": g(4),
                "tupReturned": g(5),
                "tupFetched": g(6),
                "blksRead": g(10),
                "blksHit": g(11),
                "databaseSize": g(14),
                "maxConnections": max,
            },
        }))
    })
    .await
}

pub async fn server_info(conn: &PgConn) -> AppResult<Value> {
    read(conn, None, async |c| {
        let one = async |sql: &str| -> Option<Value> {
            c.query_typed_opt(sql, &[]).await.ok().flatten().map(|r| row_to_json(&r))
        };
        let many = async |sql: &str| -> Option<Value> {
            c.query_typed(sql, &[]).await.ok().map(|rows| Value::Array(rows.iter().map(row_to_json).collect()))
        };
        let server = one(
            "SELECT version() AS version, current_setting('server_version') AS server_version,
                    current_setting('server_version_num')::int AS version_num,
                    pg_postmaster_start_time() AS started_at,
                    EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime_secs,
                    pg_is_in_recovery() AS in_recovery,
                    inet_server_addr()::text AS server_addr, inet_server_port() AS server_port,
                    current_setting('data_directory', true) AS data_directory",
        )
        .await;
        // Anything that fails (restricted roles, managed services) comes back null.
        let session = one(
            "SELECT current_database() AS database, current_user AS user, session_user AS session_user,
                    r.rolsuper AS superuser, r.rolcreatedb AS create_db, r.rolcreaterole AS create_role,
                    r.rolreplication AS replication, current_setting('search_path') AS search_path,
                    current_setting('TimeZone') AS timezone, current_setting('server_encoding') AS encoding,
                    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
                    (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl_version,
                    (SELECT cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl_cipher
             FROM pg_roles r WHERE r.rolname = current_user",
        )
        .await;
        let database = one(
            "SELECT d.datname AS name, pg_database_size(d.datname) AS size, d.numbackends AS connections,
                    d.xact_commit, d.xact_rollback, d.blks_hit, d.blks_read, d.tup_returned,
                    d.tup_fetched, d.tup_inserted, d.tup_updated, d.tup_deleted, d.conflicts,
                    d.deadlocks, d.temp_bytes, d.stats_reset,
                    pg_encoding_to_char(db.encoding) AS encoding, db.datcollate AS collation
             FROM pg_stat_database d JOIN pg_database db ON db.datname = d.datname
             WHERE d.datname = current_database()",
        )
        .await;
        let settings = many(
            "SELECT name, setting, unit, short_desc FROM pg_settings WHERE name IN (
                'max_connections','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size',
                'wal_level','max_wal_size','checkpoint_timeout','random_page_cost','default_statistics_target',
                'statement_timeout','idle_in_transaction_session_timeout','max_parallel_workers',
                'max_worker_processes','autovacuum','ssl','shared_preload_libraries','timezone',
                'default_transaction_read_only','log_min_duration_statement')
             ORDER BY name",
        )
        .await;
        let extensions = many("SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname").await;
        let databases = many(
            "SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database
             WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
        )
        .await;
        let replication = many(
            "SELECT application_name, client_addr::text AS client, state, sync_state,
                    replay_lag::text AS replay_lag FROM pg_stat_replication",
        )
        .await;
        let connections = many(
            "SELECT COALESCE(state, backend_type) AS state, count(*) AS count FROM pg_stat_activity
             GROUP BY 1 ORDER BY 2 DESC",
        )
        .await;
        Ok(json!({
            "engine": "postgres",
            "server": server,
            "session": session,
            "database": database,
            "settings": settings,
            "extensions": extensions,
            "databases": databases,
            "replication": replication,
            "connections": connections,
        }))
    })
    .await
}

// ---------------------------------------------------------------------------
// SQL shell & read-only queries
// ---------------------------------------------------------------------------

fn outcome(kind: &str, docs: Option<Vec<Value>>, message: Option<String>, use_db: Option<String>, exec_ms: u64, limited: bool) -> ShellOutcome {
    ShellOutcome {
        kind: kind.into(),
        docs,
        value: None,
        message,
        use_db,
        exec_ms,
        applied_default_limit: limited,
    }
}

/// Run a SQL script. Statements run one by one on one connection, like psql:
/// each commits on its own unless the script manages its own transaction. A
/// read-only workspace wraps everything in `BEGIN READ ONLY` (rolled back at
/// the end) and refuses transaction control. The result shown is the last
/// statement that returned rows; the others are summarized in the message.
pub async fn run_shell(conn: &PgConn, schema: &str, text: &str, read_only: bool) -> AppResult<ShellOutcome> {
    let statements = super::sql::split_statements(text);
    if statements.is_empty() {
        return Err(AppError::Parse("nothing to run".into()));
    }
    if read_only {
        for stmt in &statements {
            if let Some(why) = super::sql::read_only_violation(stmt) {
                return Err(AppError::Other(why));
            }
        }
    }
    let started = Instant::now();
    let client = conn.pool.get().await?;
    let path = format!("{}, public", qi(schema));
    if read_only {
        client.batch_execute("BEGIN READ ONLY").await?;
        client.batch_execute(&format!("SET LOCAL search_path TO {path}")).await?;
    } else {
        client.batch_execute(&format!("SET search_path TO {path}")).await?;
    }

    let mut docs: Option<(Vec<Value>, bool)> = None;
    let mut messages: Vec<String> = Vec::new();
    let mut use_db: Option<String> = None;
    let multi = statements.len() > 1;
    let mut failure: Option<AppError> = None;
    for (i, stmt) in statements.iter().enumerate() {
        let result = collect_rows(&client, stmt, &[], SHELL_ROW_LIMIT).await;
        match result {
            Ok((rows, more, affected)) => {
                if let Some(target) = super::sql::search_path_target(stmt) {
                    use_db = Some(target);
                }
                if super::sql::returns_rows(stmt) || !rows.is_empty() {
                    messages.push(format!("{} · {} row{}", super::sql::command_tag(stmt), rows.len(), if rows.len() == 1 { "" } else { "s" }));
                    docs = Some((rows, more));
                } else {
                    let tag = super::sql::command_tag(stmt);
                    messages.push(match affected {
                        Some(n) if matches!(tag.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY") => {
                            format!("{tag} · {n} row{}", if n == 1 { "" } else { "s" })
                        }
                        _ => tag,
                    });
                }
            }
            Err(e) => {
                let msg = if multi { format!("statement {} failed: {e}", i + 1) } else { e.to_string() };
                failure = Some(AppError::Other(msg));
                break;
            }
        }
    }

    // Leave the pooled connection clean: a script that opened a transaction
    // and never committed gets rolled back (and told so).
    let open_tx = if read_only {
        false
    } else {
        client
            .query_typed_one("SELECT now() <> statement_timestamp()", &[])
            .await
            .map(|r| r.get::<_, bool>(0))
            .unwrap_or(true)
    };
    let cleanup = if read_only { "ROLLBACK".to_string() } else { "ROLLBACK; RESET search_path".to_string() };
    if client.batch_execute(&cleanup).await.is_err() {
        let _ = deadpool_postgres::Object::take(client);
    }
    if let Some(e) = failure {
        return Err(e);
    }
    if open_tx {
        messages.push("the script left a transaction open - it was rolled back (end with COMMIT to keep changes)".into());
    }
    let message = Some(messages.join("\n"));
    let exec_ms = ms(started);
    Ok(match (docs, use_db) {
        (Some((rows, more)), _) => outcome("docs", Some(rows), message, None, exec_ms, more),
        (None, Some(schema)) => outcome("useDb", None, Some(format!("search_path set - switched to schema {schema}")), Some(schema), exec_ms, false),
        (None, None) => outcome("message", None, message, None, exec_ms, false),
    })
}

/// A single read-only query (AI Studio): one SELECT, validated, inside a
/// read-only transaction with a time limit, capped at `limit` rows.
pub async fn query_read_only(conn: &PgConn, schema: &str, sql: &str, limit: usize) -> AppResult<DocsPage> {
    let stmt = super::sql::check_read_only_query(sql).map_err(AppError::Other)?;
    let path = format!("{}, public", qi(schema));
    let started = Instant::now();
    let (docs, more) = read(conn, Some(Duration::from_secs(30)), async |c| {
        c.batch_execute(&format!("SET LOCAL search_path TO {path}")).await?;
        let (rows, more, _) = collect_rows(c, &stmt, &[], limit).await?;
        Ok((rows, more))
    })
    .await?;
    Ok(DocsPage { docs, exec_ms: ms(started), applied_default_limit: more })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_sql_isolates_fragments() {
        let s = select_sql("public", "users", "age > 3 -- note", "name DESC", "");
        assert!(s.contains("WHERE (\nage > 3 -- note\n)"));
        assert!(s.ends_with("ORDER BY\nname DESC\n"));
        assert_eq!(select_sql("s", "t", "{}", " ", ""), "SELECT *\nFROM \"s\".\"t\"");
    }

    #[test]
    fn index_columns_forms() {
        assert_eq!(index_columns("{ email: 1, at: -1 }").unwrap(), "\"email\", \"at\" DESC");
        assert_eq!(index_columns("(lower(email))").unwrap(), "lower(email)");
        assert!(index_columns("  ").is_err());
    }

    #[test]
    fn index_names() {
        assert_eq!(index_name("users", "email, created_at DESC", false), "users_email_created_at_idx");
        assert_eq!(index_name("users", "lower(email)", true), "users_lower_email_key");
        assert!(index_name("t", &"x, ".repeat(40), false).len() <= 63);
    }

    #[test]
    fn retargets_index() {
        let def = "CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)";
        assert_eq!(
            retarget_index(def, "copy_email_key", "\"x\".\"copy\"").unwrap(),
            "CREATE UNIQUE INDEX \"copy_email_key\" ON \"x\".\"copy\" USING btree (email)"
        );
    }

    #[test]
    fn keys_and_suggestions() {
        let meta = TableMeta {
            kind: "table".into(),
            columns: vec![
                ColumnMeta { name: "id".into(), data_type: "integer".into(), nullable: false, default: None, identity: None, generated: false },
                ColumnMeta { name: "status".into(), data_type: "text".into(), nullable: true, default: None, identity: None, generated: false },
                ColumnMeta { name: "created_at".into(), data_type: "timestamptz".into(), nullable: true, default: None, identity: None, generated: false },
            ],
            primary_key: vec!["id".into()],
            comment: None,
        };
        assert_eq!(key_object(&meta, &json!(5)).unwrap(), json!({"id": 5}));
        assert!(key_object(&meta, &json!({"x": 1})).is_err());
        assert_eq!(pk_of(&meta, &json!({"id": 1, "status": "a"})), json!({"id": 1}));
        assert_eq!(
            suggest_index(&meta, "status = 'created_at'", "created_at DESC").unwrap(),
            json!({"status": 1, "created_at": -1})
        );
    }
}
