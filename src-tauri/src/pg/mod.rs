//! PostgreSQL support. One module per concern:
//!
//!  * `mod.rs` - connection strings, TLS (`sslmode`), pooling, SSH tunnels,
//!    and the read-only transaction helper every read goes through.
//!  * `value` - binary row values to JSON (and back, via `jsonb_populate_record`).
//!  * `sql` - statement splitting / classification for the SQL shell.
//!  * `ops` - the explorer commands (tables, rows, indexes, explain, ...).
//!
//! Any hosted Postgres works the same way - Neon, Supabase, Tiger Cloud, RDS,
//! PlanetScale Postgres - they all speak the wire protocol. The only provider
//! differences are connection details: TLS (handled libpq-style through
//! `sslmode`), SNI (rustls sends it), and transaction-mode poolers
//! (PgBouncer / Supavisor), which is why every query here uses unnamed
//! statements (`query_typed`) instead of named prepared ones.

pub mod ops;
pub mod sql;
pub mod value;

#[cfg(test)]
mod live_tests;

use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio_postgres::config::SslMode;

use crate::error::{AppError, AppResult};
use crate::profiles::pct_decode;

/// A live Postgres workspace: the pool plus what the explorer needs to know.
#[derive(Clone)]
pub struct PgConn {
    pub pool: Pool,
    /// Database the pool is bound to (Postgres connections are per database).
    pub database: String,
    /// Schema to select first (`?schema=` from Prisma-style URIs), if given.
    pub default_schema: Option<String>,
}

/// True for `postgres://` / `postgresql://` connection strings.
pub fn is_pg_uri(uri: &str) -> bool {
    let lower = uri.trim_start().to_ascii_lowercase();
    lower.starts_with("postgres://") || lower.starts_with("postgresql://")
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        AppError::Other(pg_error_message(&e))
    }
}

impl From<deadpool_postgres::PoolError> for AppError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        match e {
            deadpool_postgres::PoolError::Backend(e) => e.into(),
            deadpool_postgres::PoolError::Timeout(_) => {
                AppError::Other("timed out waiting for a PostgreSQL connection".into())
            }
            other => AppError::Other(format!("PostgreSQL pool: {other}")),
        }
    }
}

/// Server errors read best as "message (detail) hint"; everything else keeps
/// the driver's text minus its "db error:" prefix.
pub fn pg_error_message(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut msg = db.message().to_string();
        if let Some(detail) = db.detail() {
            msg.push_str(&format!(" - {detail}"));
        }
        if let Some(hint) = db.hint() {
            msg.push_str(&format!(" (hint: {hint})"));
        }
        return msg;
    }
    let text = e.to_string();
    // `Error::source` usually carries the useful bit for io / tls failures.
    let source = std::error::Error::source(e).map(|s| s.to_string());
    match source {
        Some(s) if !text.contains(&s) => format!("{text}: {s}"),
        _ => text,
    }
}

// ---------------------------------------------------------------------------
// connection strings
// ---------------------------------------------------------------------------

/// A parsed `postgresql://` URI. We parse it ourselves instead of handing it to
/// `tokio_postgres::Config::from_str` because real-world strings carry
/// parameters that parser rejects (`sslrootcert`, `sslmode=verify-full`,
/// Prisma's `schema` / `pgbouncer`, ...).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PgUri {
    pub user: Option<String>,
    pub password: Option<String>,
    /// (host, port) pairs; a host starting with `/` is a unix socket directory.
    pub hosts: Vec<(String, Option<u16>)>,
    pub dbname: Option<String>,
    pub sslmode: String,
    pub sslrootcert: Option<String>,
    pub sslcert: Option<String>,
    pub sslkey: Option<String>,
    pub schema: Option<String>,
    /// Remaining `key=value` parameters, decoded.
    pub params: Vec<(String, String)>,
}

pub fn parse_uri(uri: &str) -> AppResult<PgUri> {
    let uri = uri.trim();
    let (scheme, rest) = uri
        .split_once("://")
        .ok_or_else(|| AppError::Other("invalid connection string: missing scheme".into()))?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "postgres" | "postgresql") {
        return Err(AppError::Other(format!("not a PostgreSQL connection string ({scheme}://)")));
    }
    let (head, query) = match rest.split_once('?') {
        Some((h, q)) => (h, q),
        None => (rest, ""),
    };
    // Hosts never contain '@', so the last '@' ends the userinfo - even when
    // an unescaped '@' sits inside the password.
    let (userinfo, hostpath) = match head.rfind('@') {
        Some(at) => (Some(&head[..at]), &head[at + 1..]),
        None => (None, head),
    };
    let (hostlist, db) = match hostpath.split_once('/') {
        Some((h, d)) => (h, Some(d)),
        None => (hostpath, None),
    };

    let mut out = PgUri { sslmode: "prefer".into(), ..Default::default() };
    if let Some(ui) = userinfo {
        let (u, p) = match ui.split_once(':') {
            Some((u, p)) => (u, Some(p)),
            None => (ui, None),
        };
        out.user = Some(pct_decode(u)).filter(|s| !s.is_empty());
        out.password = p.map(pct_decode).filter(|s| !s.is_empty());
    }
    for h in hostlist.split(',').map(str::trim).filter(|h| !h.is_empty()) {
        let h = pct_decode(h);
        out.hosts.push(split_host_port(&h));
    }
    out.dbname = db.map(pct_decode).filter(|d| !d.is_empty());

    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (pct_decode(k), pct_decode(v));
        match k.as_str() {
            "sslmode" => out.sslmode = v.to_ascii_lowercase(),
            "sslrootcert" => out.sslrootcert = Some(v),
            "sslcert" => out.sslcert = Some(v),
            "sslkey" => out.sslkey = Some(v),
            "schema" | "currentSchema" => out.schema = Some(v).filter(|s| !s.is_empty()),
            // libpq lets query parameters override the authority part.
            "user" => out.user = Some(v),
            "password" => out.password = Some(v),
            "dbname" => out.dbname = Some(v),
            "host" => {
                out.hosts = v.split(',').map(|h| split_host_port(h.trim())).collect();
            }
            "port" => {
                let ports: Vec<Option<u16>> = v.split(',').map(|p| p.trim().parse().ok()).collect();
                for (i, host) in out.hosts.iter_mut().enumerate() {
                    host.1 = ports.get(i).copied().flatten().or(ports.first().copied().flatten());
                }
            }
            _ => out.params.push((k, v)),
        }
    }
    if out.hosts.is_empty() {
        out.hosts.push(("localhost".into(), None));
    }
    Ok(out)
}

fn split_host_port(h: &str) -> (String, Option<u16>) {
    if let Some(rest) = h.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            return (host.to_string(), tail.strip_prefix(':').and_then(|p| p.parse().ok()));
        }
    }
    match h.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse().ok())
        }
        _ => (h.to_string(), None),
    }
}

/// "user@host:5432/db" for the status bar - never includes the password.
pub fn host_summary(u: &PgUri) -> String {
    let hosts = u
        .hosts
        .iter()
        .map(|(h, p)| match p {
            Some(p) => format!("{h}:{p}"),
            None => h.clone(),
        })
        .collect::<Vec<_>>()
        .join(",");
    let mut s = String::new();
    if let Some(user) = &u.user {
        s.push_str(user);
        s.push('@');
    }
    s.push_str(&hosts);
    if let Some(db) = &u.dbname {
        s.push('/');
        s.push_str(db);
    }
    s
}

/// Best-effort hosting provider from the host name, for the status bar.
pub fn provider_for(host: &str) -> Option<&'static str> {
    let h = host.to_ascii_lowercase();
    let known: &[(&str, &str)] = &[
        ("neon.tech", "Neon"),
        ("supabase.co", "Supabase"),
        ("supabase.com", "Supabase"),
        ("pooler.supabase", "Supabase"),
        ("tsdb.cloud.timescale.com", "Tiger Cloud"),
        ("timescale.com", "Tiger Cloud"),
        ("psdb.cloud", "PlanetScale"),
        ("planetscale", "PlanetScale"),
        ("rds.amazonaws.com", "AWS RDS"),
        ("cloudsql", "Google Cloud SQL"),
        ("postgres.database.azure.com", "Azure"),
        ("render.com", "Render"),
        ("railway", "Railway"),
        ("crunchybridge.com", "Crunchy Bridge"),
        ("aivencloud.com", "Aiven"),
        ("db.ondigitalocean.com", "DigitalOcean"),
        ("cockroachlabs.cloud", "CockroachDB"),
        ("xata.sh", "Xata"),
        ("nile", "Nile"),
    ];
    known.iter().find(|(needle, _)| h.contains(needle)).map(|(_, name)| *name)
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts any certificate but still checks the handshake signatures - the
/// libpq meaning of `sslmode=require` / `prefer`: encrypted, not authenticated.
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// `sslmode=verify-ca`: the chain must lead to a trusted root, but the
/// certificate need not name the host.
#[derive(Debug)]
struct VerifyCaOnly(Arc<rustls::client::WebPkiServerVerifier>);

impl ServerCertVerifier for VerifyCaOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.0.verify_server_cert(end_entity, intermediates, server_name, ocsp, now) {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.0.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_verify_schemes()
    }
}

fn expand_home(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

fn read_pem_certs(path: &str) -> AppResult<Vec<CertificateDer<'static>>> {
    use rustls::pki_types::pem::PemObject;
    let path = expand_home(path);
    let certs: Result<Vec<_>, _> = CertificateDer::pem_file_iter(&path)
        .map_err(|e| AppError::Other(format!("could not read {}: {e}", path.display())))?
        .collect();
    let certs = certs.map_err(|e| AppError::Other(format!("could not parse {}: {e}", path.display())))?;
    if certs.is_empty() {
        return Err(AppError::Other(format!("no certificates found in {}", path.display())));
    }
    Ok(certs)
}

/// Trust roots for verify-ca / verify-full: the `sslrootcert` file when given
/// (`system` means the OS store, as in libpq 16+), else the OS store plus the
/// Mozilla bundle.
fn root_store(sslrootcert: Option<&str>) -> AppResult<rustls::RootCertStore> {
    let mut roots = rustls::RootCertStore::empty();
    match sslrootcert.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) if path != "system" => {
            for cert in read_pem_certs(path)? {
                roots
                    .add(cert)
                    .map_err(|e| AppError::Other(format!("invalid root certificate: {e}")))?;
            }
        }
        system => {
            for cert in rustls_native_certs::load_native_certs().certs {
                let _ = roots.add(cert);
            }
            if system.is_none() {
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            }
        }
    }
    Ok(roots)
}

fn tls_config(u: &PgUri) -> AppResult<rustls::ClientConfig> {
    let provider = provider();
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Other(format!("TLS setup failed: {e}")))?;
    // libpq: with sslmode=require and a root certificate on hand, verify the chain.
    let mode = match (u.sslmode.as_str(), u.sslrootcert.is_some()) {
        ("require", true) => "verify-ca",
        (m, _) => m,
    };
    let builder = match mode {
        "verify-full" => builder.with_root_certificates(root_store(u.sslrootcert.as_deref())?),
        "verify-ca" => {
            let roots = Arc::new(root_store(u.sslrootcert.as_deref())?);
            let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
                .build()
                .map_err(|e| AppError::Other(format!("TLS setup failed: {e}")))?;
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(VerifyCaOnly(inner)))
        }
        _ => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify(provider.clone()))),
    };
    match (&u.sslcert, &u.sslkey) {
        (Some(cert), Some(key)) => {
            use rustls::pki_types::pem::PemObject;
            let chain = read_pem_certs(cert)?;
            let key_path = expand_home(key);
            let key = PrivateKeyDer::from_pem_file(&key_path)
                .map_err(|e| AppError::Other(format!("could not read {}: {e}", key_path.display())))?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|e| AppError::Other(format!("invalid client certificate: {e}")))
        }
        (Some(_), None) | (None, Some(_)) => Err(AppError::Other(
            "a client certificate needs both sslcert and sslkey".into(),
        )),
        (None, None) => Ok(builder.with_no_client_auth()),
    }
}

// ---------------------------------------------------------------------------
// connecting
// ---------------------------------------------------------------------------

pub struct Established {
    pub conn: PgConn,
    pub host_summary: String,
    pub server_version: String,
    pub topology: String,
    pub latency_ms: u64,
    pub tunnel: Option<crate::ssh::Tunnel>,
}

const PASSTHROUGH: &[&str] = &[
    "application_name",
    "options",
    "connect_timeout",
    "keepalives",
    "keepalives_idle",
    "target_session_attrs",
    "channel_binding",
    "load_balance_hosts",
    "sslnegotiation",
];

fn build_config(u: &PgUri, tunnel_port: Option<u16>) -> AppResult<tokio_postgres::Config> {
    let mut cfg = tokio_postgres::Config::new();
    if let Some(user) = &u.user {
        cfg.user(user);
    }
    if let Some(pass) = &u.password {
        cfg.password(pass);
    }
    cfg.dbname(u.dbname.as_deref().or(u.user.as_deref()).unwrap_or("postgres"));
    match tunnel_port {
        Some(port) => {
            // Connect to the local tunnel end but keep the real host name so
            // TLS (SNI + certificate checks) sees what the server expects.
            let (host, _) = &u.hosts[0];
            cfg.host(host);
            cfg.hostaddr(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
            cfg.port(port);
        }
        None => {
            for (host, port) in &u.hosts {
                cfg.host(host);
                cfg.port(port.unwrap_or(5432));
            }
        }
    }
    cfg.ssl_mode(match u.sslmode.as_str() {
        "disable" => SslMode::Disable,
        "allow" | "prefer" | "" => SslMode::Prefer,
        "require" | "verify-ca" | "verify-full" => SslMode::Require,
        other => return Err(AppError::Other(format!("unknown sslmode '{other}'"))),
    });
    cfg.connect_timeout(Duration::from_secs(10));
    cfg.application_name(format!("Mongo Bongo {}", env!("CARGO_PKG_VERSION")));
    cfg.keepalives_idle(Duration::from_secs(60));

    let mut extra = String::new();
    for (k, v) in &u.params {
        if !PASSTHROUGH.contains(&k.as_str()) {
            continue; // e.g. Prisma's `pgbouncer=true`, `connection_limit`
        }
        let esc = v.replace('\\', "\\\\").replace('\'', "\\'");
        extra.push_str(&format!("{k}='{esc}' "));
    }
    if !extra.is_empty() {
        // Reuse the driver's own key/value parser for the rarer options.
        let parsed: tokio_postgres::Config = extra
            .parse()
            .map_err(|e| AppError::Other(format!("invalid connection option: {e}")))?;
        if let Some(name) = parsed.get_application_name() {
            cfg.application_name(name);
        }
        if let Some(options) = parsed.get_options() {
            cfg.options(options);
        }
        if let Some(t) = parsed.get_connect_timeout() {
            cfg.connect_timeout(*t);
        }
        cfg.keepalives(parsed.get_keepalives());
        cfg.keepalives_idle(parsed.get_keepalives_idle());
        cfg.target_session_attrs(parsed.get_target_session_attrs());
        cfg.channel_binding(parsed.get_channel_binding());
        cfg.load_balance_hosts(parsed.get_load_balance_hosts());
        cfg.ssl_negotiation(parsed.get_ssl_negotiation());
    }
    Ok(cfg)
}

pub async fn establish(
    uri: &str,
    ssh: Option<(crate::ssh::SshConfig, Option<String>)>,
    data_dir: &std::path::Path,
) -> AppResult<Established> {
    let parsed = match parse_uri(uri) {
        Ok(p) => p,
        Err(first) => match crate::profiles::repair_userinfo(uri) {
            Some(fixed) => parse_uri(&fixed).map_err(|_| first)?,
            None => return Err(first),
        },
    };
    if parsed.hosts.iter().any(|(h, _)| h.starts_with('/')) && ssh.is_some() {
        return Err(AppError::Other("SSH tunnels need a TCP host, not a unix socket".into()));
    }

    let tunnel = match &ssh {
        Some((cfg, secret)) => {
            let (host, port) = &parsed.hosts[0];
            Some(crate::ssh::open(cfg, secret.as_deref(), host, port.unwrap_or(5432), data_dir).await?)
        }
        None => None,
    };
    let config = build_config(&parsed, tunnel.as_ref().map(|t| t.local_port))?;
    let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config(&parsed)?);
    let manager = Manager::from_config(
        config,
        tls,
        ManagerConfig { recycling_method: RecyclingMethod::Fast },
    );
    let pool = Pool::builder(manager)
        .max_size(6)
        .wait_timeout(Some(Duration::from_secs(20)))
        .create_timeout(Some(Duration::from_secs(15)))
        .runtime(deadpool_postgres::Runtime::Tokio1)
        .build()
        .map_err(|e| AppError::Other(format!("PostgreSQL pool: {e}")))?;

    let started = Instant::now();
    let client = pool.get().await?;
    client.query_typed("SELECT 1", &[]).await?;
    let latency_ms = started.elapsed().as_millis() as u64;

    let row = client
        .query_typed_one(
            "SELECT current_setting('server_version'), current_database(), pg_is_in_recovery()",
            &[],
        )
        .await?;
    let version: String = row.get(0);
    let database: String = row.get(1);
    let standby: bool = row.get(2);
    let server_version = version.split_whitespace().next().unwrap_or(&version).to_string();
    let role = if standby { "standby" } else { "primary" };
    let topology = match provider_for(&parsed.hosts[0].0) {
        Some(p) => format!("PostgreSQL · {p} · {role}"),
        None => format!("PostgreSQL · {role}"),
    };
    drop(client);

    Ok(Established {
        conn: PgConn { pool, database, default_schema: parsed.schema.clone() },
        host_summary: host_summary(&parsed),
        server_version,
        topology,
        latency_ms,
        tunnel,
    })
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

pub type PgClient = deadpool_postgres::Object;

/// Run `body` inside a transaction. Read-only transactions make the server
/// itself refuse writes - the explorer's reads, the shell in a read-only
/// workspace and AI Studio all go through here. The transaction is rolled back
/// unless `commit` is set, so a read never leaves anything behind.
pub async fn with_tx<T>(
    conn: &PgConn,
    read_only: bool,
    timeout: Option<Duration>,
    commit: bool,
    body: impl AsyncFnOnce(&PgClient) -> AppResult<T>,
) -> AppResult<T> {
    let client = conn.pool.get().await?;
    let begin = if read_only { "BEGIN READ ONLY" } else { "BEGIN" };
    client.batch_execute(begin).await?;
    if let Some(t) = timeout {
        client
            .batch_execute(&format!("SET LOCAL statement_timeout = {}", t.as_millis()))
            .await?;
    }
    let result = body(&client).await;
    let end = if result.is_ok() && commit { "COMMIT" } else { "ROLLBACK" };
    if let Err(e) = client.batch_execute(end).await {
        // A broken connection must not go back into the pool.
        let _ = deadpool_postgres::Object::take(client);
        return result.and(Err(e.into()));
    }
    result
}

/// Shorthand for the common case: a read-only, rolled-back transaction.
pub async fn read<T>(
    conn: &PgConn,
    timeout: Option<Duration>,
    body: impl AsyncFnOnce(&PgClient) -> AppResult<T>,
) -> AppResult<T> {
    with_tx(conn, true, timeout, false, body).await
}

/// A committed read-write transaction.
pub async fn write<T>(
    conn: &PgConn,
    body: impl AsyncFnOnce(&PgClient) -> AppResult<T>,
) -> AppResult<T> {
    with_tx(conn, false, None, true, body).await
}

/// Quote an identifier: `users` -> `"users"`, `a"b` -> `"a""b"`.
pub fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Schema-qualified, quoted relation name.
pub fn rel(schema: &str, table: &str) -> String {
    format!("{}.{}", qi(schema), qi(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_uri() {
        let u = parse_uri("postgresql://app:p%40ss@db.example.com:6543/shop?sslmode=require&application_name=x").unwrap();
        assert_eq!(u.user.as_deref(), Some("app"));
        assert_eq!(u.password.as_deref(), Some("p@ss"));
        assert_eq!(u.hosts, vec![("db.example.com".to_string(), Some(6543))]);
        assert_eq!(u.dbname.as_deref(), Some("shop"));
        assert_eq!(u.sslmode, "require");
        assert_eq!(u.params, vec![("application_name".to_string(), "x".to_string())]);
    }

    #[test]
    fn parses_unescaped_at_and_defaults() {
        let u = parse_uri("postgres://u:pa@ss@localhost/db").unwrap();
        assert_eq!(u.password.as_deref(), Some("pa@ss"));
        assert_eq!(u.sslmode, "prefer");
        let bare = parse_uri("postgres://").unwrap();
        assert_eq!(bare.hosts, vec![("localhost".to_string(), None)]);
    }

    #[test]
    fn parses_prisma_and_multi_host() {
        let u = parse_uri("postgresql://u@h1:5432,h2:5433/db?schema=app&pgbouncer=true&sslmode=verify-full").unwrap();
        assert_eq!(u.hosts.len(), 2);
        assert_eq!(u.hosts[1], ("h2".to_string(), Some(5433)));
        assert_eq!(u.schema.as_deref(), Some("app"));
        assert_eq!(u.sslmode, "verify-full");
        assert!(build_config(&u, None).is_ok());
    }

    #[test]
    fn ipv6_and_socket_hosts() {
        let u = parse_uri("postgresql://[::1]:5433/db").unwrap();
        assert_eq!(u.hosts[0], ("::1".to_string(), Some(5433)));
        let s = parse_uri("postgresql:///db?host=%2Fvar%2Frun%2Fpostgresql").unwrap();
        assert_eq!(s.hosts[0].0, "/var/run/postgresql");
    }

    #[test]
    fn summary_hides_password() {
        let u = parse_uri("postgresql://app:secret@db:5432/shop").unwrap();
        assert_eq!(host_summary(&u), "app@db:5432/shop");
    }

    #[test]
    fn providers() {
        assert_eq!(provider_for("ep-cool-1.us-east-2.aws.neon.tech"), Some("Neon"));
        assert_eq!(provider_for("aws-0-us-east-1.pooler.supabase.com"), Some("Supabase"));
        assert_eq!(provider_for("abc.tsdb.cloud.timescale.com"), Some("Tiger Cloud"));
        assert_eq!(provider_for("localhost"), None);
    }

    #[test]
    fn quoting() {
        assert_eq!(qi("a\"b"), "\"a\"\"b\"");
        assert_eq!(rel("public", "users"), "\"public\".\"users\"");
    }

    #[test]
    fn unknown_sslmode_rejected() {
        let u = parse_uri("postgresql://h/db?sslmode=bogus").unwrap();
        assert!(build_config(&u, None).is_err());
    }
}
