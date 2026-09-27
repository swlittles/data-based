//! End-to-end tests against a real server. Skipped unless `MB_PG_URL` points
//! at a disposable database, e.g.
//! `MB_PG_URL=postgresql://postgres:secret@localhost:55432/postgres cargo test live`.
//! Optional `MB_PG_CA` (a PEM file) enables the verify-full test.

use std::sync::atomic::AtomicBool;

use serde_json::{json, Value};

use super::ops;
use super::{establish, PgConn};

fn url() -> Option<String> {
    std::env::var("MB_PG_URL").ok().filter(|u| !u.is_empty())
}

async fn connect(u: &str) -> PgConn {
    establish(u, None, std::path::Path::new("/tmp")).await.expect("connect").conn
}

async fn fresh_schema(conn: &PgConn, name: &str) {
    ops::run_shell(conn, "public", &format!("DROP SCHEMA IF EXISTS {name} CASCADE; CREATE SCHEMA {name}"), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn live_tls_modes() {
    let Some(u) = url() else { return };
    let sep = if u.contains('?') { '&' } else { '?' };
    for mode in ["disable", "prefer", "require"] {
        let e = establish(&format!("{u}{sep}sslmode={mode}"), None, std::path::Path::new("/tmp")).await;
        assert!(e.is_ok(), "sslmode={mode}: {:?}", e.err().map(|e| e.to_string()));
    }
    // verify-full against the system roots must reject a self-signed cert.
    let bad = establish(&format!("{u}{sep}sslmode=verify-full"), None, std::path::Path::new("/tmp")).await;
    assert!(bad.is_err());
    if let Ok(ca) = std::env::var("MB_PG_CA") {
        let ok = establish(&format!("{u}{sep}sslmode=verify-full&sslrootcert={ca}"), None, std::path::Path::new("/tmp")).await;
        assert!(ok.is_ok(), "verify-full with CA: {:?}", ok.err().map(|e| e.to_string()));
        let ok = establish(&format!("{u}{sep}sslmode=verify-ca&sslrootcert={ca}"), None, std::path::Path::new("/tmp")).await;
        assert!(ok.is_ok());
        // Same server by IP: the certificate names "localhost", so verify-full
        // must refuse while verify-ca (chain only) accepts.
        let by_ip = u.replace("localhost", "127.0.0.1");
        let sep = if by_ip.contains('?') { '&' } else { '?' };
        let full = establish(&format!("{by_ip}{sep}sslmode=verify-full&sslrootcert={ca}"), None, std::path::Path::new("/tmp")).await;
        assert!(full.is_err());
        let ca_only = establish(&format!("{by_ip}{sep}sslmode=verify-ca&sslrootcert={ca}"), None, std::path::Path::new("/tmp")).await;
        assert!(ca_only.is_ok(), "{:?}", ca_only.err().map(|e| e.to_string()));
    }
}

#[tokio::test]
async fn live_explorer_roundtrip() {
    let Some(u) = url() else { return };
    let conn = connect(&u).await;
    fresh_schema(&conn, "mb_it").await;
    let setup = r#"
        CREATE TYPE mb_it.mood AS ENUM ('happy', 'sad');
        CREATE TABLE mb_it.people (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name text NOT NULL,
            age int,
            score numeric(12,2),
            big bigint,
            tags text[],
            meta jsonb,
            born date,
            seen timestamptz,
            mood mb_it.mood,
            photo bytea,
            ip inet,
            span interval,
            uid uuid,
            name_len int GENERATED ALWAYS AS (length(name)) STORED
        );
        INSERT INTO mb_it.people (name, age, score, big, tags, meta, born, seen, mood, photo, ip, span, uid) VALUES
          ('Ada', 36, 12.50, 9007199254740993, '{a,b}', '{"k": {"n": 1}}', '1815-12-10', '2024-05-01 10:00:00+00', 'happy', '\xdeadbeef', '10.0.0.1', '1 day 02:00:00', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
          ('Linus', 54, NULL, 1, NULL, NULL, NULL, NULL, 'sad', NULL, NULL, NULL, NULL);
        CREATE TABLE mb_it.orders (id serial PRIMARY KEY, person_id bigint REFERENCES mb_it.people(id), total numeric);
        CREATE VIEW mb_it.adults AS SELECT * FROM mb_it.people WHERE age >= 18;
        ANALYZE mb_it.people;
    "#;
    ops::run_shell(&conn, "mb_it", setup, false).await.unwrap();

    let schemas = ops::list_schemas(&conn).await.unwrap();
    assert!(schemas.iter().any(|s| s.name == "mb_it"));
    let tables = ops::list_tables(&conn, "mb_it").await.unwrap();
    let kinds: Vec<(String, String)> = tables.iter().map(|t| (t.name.clone(), t.kind.clone())).collect();
    assert!(kinds.contains(&("adults".into(), "view".into())));
    assert!(kinds.contains(&("people".into(), "table".into())));

    // find + value decoding
    let page = ops::find(&conn, "mb_it", "people", "name = 'Ada'", "id", "", 10, 0).await.unwrap();
    let ada = &page.docs[0];
    assert_eq!(ada["score"], json!(12.5));
    assert_eq!(ada["big"], json!("9007199254740993"));
    assert_eq!(ada["tags"], json!(["a", "b"]));
    assert_eq!(ada["meta"], json!({"k": {"n": 1}}));
    assert_eq!(ada["born"], json!("1815-12-10"));
    assert_eq!(ada["seen"], json!("2024-05-01T10:00:00Z"));
    assert_eq!(ada["mood"], json!("happy"));
    assert_eq!(ada["photo"], json!("\\xdeadbeef"));
    assert_eq!(ada["ip"], json!("10.0.0.1"));
    assert_eq!(ada["span"], json!("1 day 02:00:00"));
    assert_eq!(ada["uid"], json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"));
    assert_eq!(ada["name_len"], json!(3));
    // comment in a filter can't eat the LIMIT
    let page = ops::find(&conn, "mb_it", "people", "true -- all", "", "", 1, 0).await.unwrap();
    assert_eq!(page.docs.len(), 1);
    // projection
    let page = ops::find(&conn, "mb_it", "people", "", "name", "name, age * 2 AS double_age", 10, 0).await.unwrap();
    assert_eq!(page.docs[0], json!({"name": "Ada", "double_age": 72}));

    let c = ops::count(&conn, "mb_it", "people", "age > 40").await.unwrap();
    assert_eq!((c.count, c.exact), (Some(1), true));

    // insert: round-trip the decoded values back in (the edit path)
    let mut copy = ada.clone();
    let obj = copy.as_object_mut().unwrap();
    obj.remove("id");
    obj.remove("name_len");
    obj.insert("name".into(), json!("Ada II"));
    let inserted = ops::insert(&conn, "mb_it", "people", &copy.to_string()).await.unwrap();
    let new_id = inserted["insertedId"].clone();
    assert!(new_id.get("id").is_some());
    let back = ops::find(&conn, "mb_it", "people", "name = 'Ada II'", "", "", 1, 0).await.unwrap();
    for k in ["score", "big", "tags", "meta", "born", "seen", "mood", "photo", "ip", "span", "uid"] {
        assert_eq!(back.docs[0][k], ada[k], "round trip of {k}");
    }

    // replace (only listed columns change) and delete by key
    ops::replace(&conn, "mb_it", "people", &new_id, r#"{"age": 99, "id": 12345, "name_len": 1}"#).await.unwrap();
    let back = ops::find(&conn, "mb_it", "people", "name = 'Ada II'", "", "", 1, 0).await.unwrap();
    assert_eq!(back.docs[0]["age"], json!(99));
    assert_eq!(back.docs[0]["id"], new_id["id"]);
    assert!(ops::insert(&conn, "mb_it", "people", r#"{"nope": 1}"#).await.is_err());
    let d = ops::delete(&conn, "mb_it", "people", &new_id).await.unwrap();
    assert_eq!(d["deleted"], json!(1));
    assert!(ops::delete(&conn, "mb_it", "adults", &json!({"id": 1})).await.is_err());

    // bulk
    let u = ops::bulk_update(&conn, "mb_it", "people", "age IS NOT NULL", "SET age = age + 1").await.unwrap();
    assert_eq!(u["matched"], json!(2));
    assert!(ops::bulk_delete(&conn, "mb_it", "people", "").await.is_err());

    // indexes
    let name = ops::create_index(&conn, "mb_it", "people", "{ age: -1 }", None, false, None, Some("age > 0".into()), false)
        .await
        .unwrap();
    assert_eq!(name, "people_age_idx");
    ops::create_index(&conn, "mb_it", "people", "meta", None, false, Some("gin".into()), None, true).await.unwrap();
    let idx = ops::list_indexes(&conn, "mb_it", "people").await.unwrap();
    assert_eq!(idx[0].primary, Some(true));
    let age = idx.iter().find(|i| i.name == "people_age_idx").unwrap();
    assert_eq!(age.keys, json!({"age": -1}));
    assert_eq!(age.partial_filter, Some(json!("(age > 0)")));
    assert!(idx.iter().any(|i| i.method.as_deref() == Some("gin")));
    ops::drop_index(&conn, "mb_it", "people_age_idx").await.unwrap();
    ops::run_shell(&conn, "mb_it", "ALTER TABLE people ADD CONSTRAINT people_name_key UNIQUE (name)", false).await.unwrap();
    ops::drop_index(&conn, "mb_it", "people_name_key").await.unwrap();
    assert!(ops::drop_index(&conn, "mb_it", "people_pkey").await.is_err());

    // explain
    let x = ops::explain(&conn, "mb_it", "people", "name = 'Ada'", "", "", "executionStats", Some(10)).await.unwrap();
    assert_eq!(x["isCollectionScan"], json!(true));
    assert_eq!(x["suggestedIndex"], json!({"name": 1}));
    assert!(x["executionTimeMillis"].is_number());

    // schema + overview + stats
    let sch = ops::analyze_schema(&conn, "mb_it", "people", 100).await.unwrap();
    let paths: Vec<&str> = sch["fields"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"meta.k.n"));
    let ov = ops::db_overview(&conn, "mb_it").await.unwrap();
    let orders = ov.collections.iter().find(|c| c.name == "orders").unwrap();
    assert_eq!(orders.refs[0].field, "person_id");
    assert_eq!(orders.refs[0].to, "people");
    let all = ops::schema_meta(&conn, "mb_it").await.unwrap();
    assert_eq!(all["people"].primary_key, vec!["id".to_string()]);
    assert_eq!(all["orders"].columns.len(), 3);
    assert_eq!(all["adults"].kind, "view");
    let st = ops::table_stats(&conn, "mb_it", "people").await.unwrap();
    assert!(st["size"].as_i64().unwrap() > 0);

    // duplicate / clear / drop
    let dup = ops::duplicate_table(&conn, "mb_it", "people", "people_copy").await.unwrap();
    assert_eq!(dup["documents"], json!(2));
    assert_eq!(ops::clear_table(&conn, "mb_it", "people_copy").await.unwrap(), 2);
    ops::drop_table(&conn, "mb_it", "people_copy").await.unwrap();
    ops::drop_table(&conn, "mb_it", "adults").await.unwrap();

    // spreadsheet export (xlsx always; numbers when opted in on a Mac with Numbers)
    let mut sheet_formats = vec!["xlsx"];
    if std::env::var("MB_NUMBERS").is_ok() && crate::sheet::numbers_available() {
        sheet_formats.push("numbers");
    }
    for fmt in sheet_formats {
        let path = std::env::temp_dir().join(format!("mb_it_export_{}.{fmt}", uuid::Uuid::new_v4()));
        let cancel = AtomicBool::new(false);
        let (n, canceled, truncated) =
            ops::export(&conn, "mb_it", "people", "", "id", fmt, path.to_str().unwrap(), &cancel, &|_, _| {}).await.unwrap();
        assert_eq!((n, canceled, truncated), (2, false, false), "{fmt}");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], b"PK", "{fmt} is a zip container");
        let _ = std::fs::remove_file(&path);
    }

    // export / import round trip
    for fmt in ["json", "ndjson", "csv"] {
        let path = format!("/tmp/mb_it_export.{fmt}");
        let cancel = AtomicBool::new(false);
        let (n, _, _) = ops::export(&conn, "mb_it", "people", "", "id", fmt, &path, &cancel, &|_, _| {}).await.unwrap();
        assert_eq!(n, 2);
        // Generated columns come along in the file and are skipped on insert.
        ops::run_shell(&conn, "mb_it", "CREATE TABLE mb_it.people_in (LIKE mb_it.people INCLUDING GENERATED)", false).await.unwrap();
        let (n, _) = ops::import(&conn, "mb_it", "people_in", &path, &cancel, &|_| {}).await.unwrap_or_else(|e| panic!("{fmt}: {e}"));
        assert_eq!(n, 2, "{fmt}");
        let rows = ops::find(&conn, "mb_it", "people_in", "name = 'Ada'", "", "", 1, 0).await.unwrap();
        assert_eq!(rows.docs[0]["big"], json!("9007199254740993"), "{fmt}");
        assert_eq!(rows.docs[0]["tags"], json!(["a", "b"]), "{fmt}");
        ops::drop_table(&conn, "mb_it", "people_in").await.unwrap();
    }
}

#[tokio::test]
async fn live_shell_and_guards() {
    let Some(u) = url() else { return };
    let conn = connect(&u).await;
    fresh_schema(&conn, "mb_sh").await;
    let out = ops::run_shell(&conn, "mb_sh", "create table t (id int primary key, v text); insert into t values (1,'a'),(2,'b'); select * from t order by id", false)
        .await
        .unwrap();
    assert_eq!(out.kind, "docs");
    assert_eq!(out.docs.as_ref().unwrap().len(), 2);
    assert!(out.message.as_ref().unwrap().contains("INSERT · 2 rows"));

    // read-only: server-enforced, and transaction control refused
    let err = ops::run_shell(&conn, "mb_sh", "delete from t", true).await.unwrap_err().to_string();
    assert!(err.contains("read-only"), "{err}");
    let err = ops::run_shell(&conn, "mb_sh", "commit; delete from t", true).await.unwrap_err().to_string();
    assert!(err.contains("isn't allowed"), "{err}");
    let err = ops::run_shell(&conn, "mb_sh", "select 1; delete from t", true).await.unwrap_err().to_string();
    assert!(err.contains("statement 2"), "{err}");
    let err = ops::run_shell(&conn, "mb_sh", "with d as (delete from t returning *) select * from d", true).await.unwrap_err();
    assert!(err.to_string().contains("read-only"));
    let rows = ops::run_shell(&conn, "mb_sh", "select count(*) from t", true).await.unwrap();
    assert_eq!(rows.docs.unwrap()[0]["count"], json!(2));

    // an unfinished transaction is rolled back, and the pool stays clean
    let out = ops::run_shell(&conn, "mb_sh", "begin; delete from t", false).await.unwrap();
    assert!(out.message.unwrap().contains("rolled back"));
    let rows = ops::run_shell(&conn, "mb_sh", "select count(*) from t", false).await.unwrap();
    assert_eq!(rows.docs.unwrap()[0]["count"], json!(2));

    // search_path switch
    let out = ops::run_shell(&conn, "mb_sh", "set search_path to public", false).await.unwrap();
    assert_eq!(out.use_db.as_deref(), Some("public"));

    // row cap
    let out = ops::run_shell(&conn, "mb_sh", "select generate_series(1, 5000) n", false).await.unwrap();
    assert!(out.applied_default_limit);
    assert_eq!(out.docs.unwrap().len(), 1000);

    // Studio runner
    let page = ops::query_read_only(&conn, "mb_sh", "select v, count(*) as n from t group by v order by v", 500).await.unwrap();
    assert_eq!(page.docs.len(), 2);
    assert!(ops::query_read_only(&conn, "mb_sh", "delete from t", 10).await.is_err());
    assert!(ops::query_read_only(&conn, "mb_sh", "select nextval('x')", 10).await.is_err());

    // ops panel
    assert!(ops::current_ops(&conn).await.is_ok());
    let info = ops::server_info(&conn).await.unwrap();
    assert!(info["server"]["server_version"].is_string());
    let light = ops::server_status_light(&conn).await.unwrap();
    assert!(light["connections"]["current"].as_i64().unwrap() >= 1);
    let status = ops::stat_statements_status(&conn).await.unwrap();
    if status["preloaded"] == json!(true) {
        ops::set_stat_statements(&conn, 1).await.unwrap();
        assert!(!ops::stat_statements(&conn, 10).await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn live_copy_diff_sync() {
    let Some(u) = url() else { return };
    let a = connect(&u).await;
    let b = connect(&u).await;
    fresh_schema(&a, "mb_src").await;
    ops::run_shell(&a, "public", "DROP SCHEMA IF EXISTS mb_dst CASCADE", false).await.unwrap();
    ops::run_shell(
        &a,
        "mb_src",
        "create table items (id int primary key, name text, qty int); create index items_name_idx on items (name);
         insert into items select g, 'item ' || g, g from generate_series(1, 1200) g",
        false,
    )
    .await
    .unwrap();
    let cancel = AtomicBool::new(false);
    let out = ops::copy_table(&a, &b, "mb_src", "items", "mb_dst", "items", "", true, &cancel, &|_, _| {}).await.unwrap();
    assert_eq!((out.documents, out.indexes), (1200, 1));
    assert!(ops::copy_table(&a, &b, "mb_src", "items", "mb_dst", "items", "", false, &cancel, &|_, _| {}).await.is_err());

    ops::run_shell(&b, "mb_dst", "update items set qty = 0 where id <= 3; delete from items where id = 10; insert into items values (5000, 'extra', 1)", false)
        .await
        .unwrap();
    let d = ops::diff_tables(&a, &b, "mb_src", "items", "mb_dst", "items", "", &cancel, &|_, _, _| {}).await.unwrap();
    assert_eq!((d.identical, d.changed, d.only_in_source, d.only_in_target), (1196, 3, 1, 1));

    let changed: Vec<Value> = d.changed_docs.iter().chain(d.only_in_source_docs.iter()).map(|e| e.id.clone()).collect();
    assert_eq!(ops::sync_rows(&a, &b, "mb_src", "items", "mb_dst", "items", "copy", &changed).await.unwrap(), 4);
    let extra: Vec<Value> = d.only_in_target_docs.iter().map(|e| e.id.clone()).collect();
    assert_eq!(ops::sync_rows(&a, &b, "mb_src", "items", "mb_dst", "items", "delete", &extra).await.unwrap(), 1);
    let d = ops::diff_tables(&a, &b, "mb_src", "items", "mb_dst", "items", "", &cancel, &|_, _, _| {}).await.unwrap();
    assert_eq!((d.identical, d.changed, d.only_in_source, d.only_in_target), (1200, 0, 0, 0));
}
