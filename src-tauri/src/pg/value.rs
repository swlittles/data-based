//! Postgres values to JSON.
//!
//! `tokio-postgres` always receives results in binary format, so this decodes
//! the wire representation of every common type. The text forms chosen here
//! are ones Postgres accepts back as input, which is what lets edits round-trip
//! through `jsonb_populate_record`: timestamps are ISO 8601, bytea is `\x..`
//! hex, intervals use the Postgres style, ranges use `[lo,hi)`.
//!
//! Integers beyond JavaScript's safe range and numerics with more than 15
//! significant digits come back as strings so the webview never rounds a
//! primary key or an amount.

use std::fmt::Write;

use serde_json::{Map, Number, Value};
use tokio_postgres::types::{FromSql, Kind, Type};
use tokio_postgres::Row;

type DecodeError = Box<dyn std::error::Error + Sync + Send>;

/// Any column, decoded to JSON. Never fails: unknown binary data falls back to
/// `\x..` hex.
pub struct Cell(pub Value);

impl<'a> FromSql<'a> for Cell {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        Ok(Cell(decode(ty, raw).unwrap_or_else(|_| hex(raw))))
    }
    fn from_sql_null(_: &Type) -> Result<Self, DecodeError> {
        Ok(Cell(Value::Null))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

/// A row as a JSON object in column order. Repeated column names (`a.id, b.id`)
/// get a " (2)" suffix instead of silently overwriting each other.
pub fn row_to_json(row: &Row) -> Value {
    let mut map = Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let value = row.try_get::<_, Cell>(i).map(|c| c.0).unwrap_or(Value::Null);
        let mut name = col.name().to_string();
        let mut n = 2;
        while map.contains_key(&name) {
            name = format!("{} ({n})", col.name());
            n += 1;
        }
        map.insert(name, value);
    }
    Value::Object(map)
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn int(v: i64) -> Value {
    if (-MAX_SAFE..=MAX_SAFE).contains(&v) {
        Value::Number(v.into())
    } else {
        Value::String(v.to_string())
    }
}

fn float(v: f64) -> Value {
    if v.is_nan() {
        Value::String("NaN".into())
    } else if v.is_infinite() {
        Value::String(if v > 0.0 { "Infinity" } else { "-Infinity" }.into())
    } else {
        Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn hex(raw: &[u8]) -> Value {
    let mut s = String::with_capacity(2 + raw.len() * 2);
    s.push_str("\\x");
    for b in raw {
        let _ = write!(s, "{b:02x}");
    }
    Value::String(s)
}

fn text(raw: &[u8]) -> Result<Value, DecodeError> {
    Ok(Value::String(std::str::from_utf8(raw)?.to_string()))
}

/// Text when the bytes are clean UTF-8, hex otherwise.
fn text_or_hex(raw: &[u8]) -> Value {
    match std::str::from_utf8(raw) {
        Ok(s) if !s.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) => {
            Value::String(s.to_string())
        }
        _ => hex(raw),
    }
}

struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.buf.len() < n {
            return Err("truncated value".into());
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }
    fn i16(&mut self) -> Result<i16, DecodeError> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into()?))
    }
    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into()?))
    }
    fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn i64(&mut self) -> Result<i64, DecodeError> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into()?))
    }
    fn f32(&mut self) -> Result<f32, DecodeError> {
        Ok(f32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn f64(&mut self) -> Result<f64, DecodeError> {
        Ok(f64::from_be_bytes(self.take(8)?.try_into()?))
    }
    /// A length-prefixed value (`-1` = NULL).
    fn value(&mut self) -> Result<Option<&'a [u8]>, DecodeError> {
        let len = self.i32()?;
        if len < 0 {
            return Ok(None);
        }
        Ok(Some(self.take(len as usize)?))
    }
}

fn r(buf: &[u8]) -> Reader<'_> {
    Reader { buf }
}

pub fn decode(ty: &Type, raw: &[u8]) -> Result<Value, DecodeError> {
    let v = match *ty {
        Type::BOOL => Value::Bool(r(raw).u8()? != 0),
        Type::INT2 => Value::Number(r(raw).i16()?.into()),
        Type::INT4 => Value::Number(r(raw).i32()?.into()),
        Type::INT8 => int(r(raw).i64()?),
        Type::OID | Type::XID | Type::CID | Type::REGPROC | Type::REGCLASS | Type::REGTYPE => {
            Value::Number(r(raw).u32()?.into())
        }
        Type::FLOAT4 => float(r(raw).f32()? as f64),
        Type::FLOAT8 => float(r(raw).f64()?),
        Type::NUMERIC => numeric(raw)?,
        Type::MONEY => {
            let cents = r(raw).i64()?;
            float(cents as f64 / 100.0)
        }
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN | Type::XML => text(raw)?,
        Type::CHAR => Value::String((raw.first().copied().unwrap_or(0) as char).to_string()),
        Type::JSON => serde_json::from_slice(raw)?,
        Type::JSONB => match raw.split_first() {
            Some((1, rest)) => serde_json::from_slice(rest)?,
            _ => return Err("unknown jsonb version".into()),
        },
        Type::UUID => {
            let u = uuid::Uuid::from_slice(raw)?;
            Value::String(u.hyphenated().to_string())
        }
        Type::BYTEA => hex(raw),
        Type::DATE => Value::String(date(r(raw).i32()?)),
        Type::TIMESTAMP => Value::String(timestamp(r(raw).i64()?, false)),
        Type::TIMESTAMPTZ => Value::String(timestamp(r(raw).i64()?, true)),
        Type::TIME => Value::String(time_of_day(r(raw).i64()?)),
        Type::TIMETZ => {
            let mut rd = r(raw);
            let micros = rd.i64()?;
            let west = rd.i32()?;
            Value::String(format!("{}{}", time_of_day(micros), offset(-west)))
        }
        Type::INTERVAL => {
            let mut rd = r(raw);
            let micros = rd.i64()?;
            let days = rd.i32()?;
            let months = rd.i32()?;
            Value::String(interval(months, days, micros))
        }
        Type::INET | Type::CIDR => Value::String(inet(raw)?),
        Type::MACADDR | Type::MACADDR8 => Value::String(
            raw.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"),
        ),
        Type::POINT => {
            let mut rd = r(raw);
            let (x, y) = (rd.f64()?, rd.f64()?);
            Value::String(format!("({x},{y})"))
        }
        Type::BIT | Type::VARBIT => {
            let mut rd = r(raw);
            let len = rd.i32()?.max(0) as usize;
            let bytes = rd.buf;
            let bits: String = (0..len)
                .map(|i| if bytes.get(i / 8).is_some_and(|b| b & (0x80 >> (i % 8)) != 0) { '1' } else { '0' })
                .collect();
            Value::String(bits)
        }
        Type::TS_VECTOR => Value::String(tsvector(raw)?),
        _ => match ty.kind() {
            Kind::Array(member) => array(member, raw)?,
            Kind::Domain(base) => decode(base, raw)?,
            Kind::Enum(_) => text(raw)?,
            Kind::Composite(fields) => {
                let mut rd = r(raw);
                let count = rd.i32()?.max(0) as usize;
                let mut map = Map::new();
                for i in 0..count {
                    let _oid = rd.u32()?;
                    let value = rd.value()?;
                    let (name, fty) = match fields.get(i) {
                        Some(f) => (f.name().to_string(), f.type_().clone()),
                        None => (format!("f{}", i + 1), Type::UNKNOWN),
                    };
                    let v = match value {
                        None => Value::Null,
                        Some(b) => decode(&fty, b).unwrap_or_else(|_| hex(b)),
                    };
                    map.insert(name, v);
                }
                Value::Object(map)
            }
            Kind::Range(sub) => Value::String(range(sub, raw)?),
            Kind::Multirange(range_ty) => {
                let sub = match range_ty.kind() {
                    Kind::Range(sub) => sub.clone(),
                    _ => Type::UNKNOWN,
                };
                let mut rd = r(raw);
                let count = rd.i32()?.max(0);
                let mut parts = Vec::new();
                for _ in 0..count {
                    let len = rd.i32()?.max(0) as usize;
                    parts.push(range(&sub, rd.take(len)?)?);
                }
                Value::String(format!("{{{}}}", parts.join(",")))
            }
            _ => extension(ty, raw),
        },
    };
    Ok(v)
}

/// Types from extensions have no fixed OID; recognize the popular ones by name.
fn extension(ty: &Type, raw: &[u8]) -> Value {
    match ty.name() {
        "citext" => text_or_hex(raw),
        // ltree / lquery / ltxtquery binary: version byte then text.
        "ltree" | "lquery" | "ltxtquery" => match raw.split_first() {
            Some((1, rest)) => text_or_hex(rest),
            _ => hex(raw),
        },
        "hstore" => hstore(raw).unwrap_or_else(|_| hex(raw)),
        // pgvector: dim, unused, then float4s. Text form "[1,2,3]" is also its input form.
        "vector" => (|| -> Result<Value, DecodeError> {
            let mut rd = r(raw);
            let dim = rd.u16()?;
            let _ = rd.u16()?;
            let mut parts = Vec::with_capacity(dim as usize);
            for _ in 0..dim {
                parts.push(rd.f32()?.to_string());
            }
            Ok(Value::String(format!("[{}]", parts.join(","))))
        })()
        .unwrap_or_else(|_| hex(raw)),
        // PostGIS prints geometries as upper-case hex EWKB - which is exactly
        // the binary send format, hex encoded.
        "geometry" | "geography" => {
            Value::String(raw.iter().map(|b| format!("{b:02X}")).collect())
        }
        _ => text_or_hex(raw),
    }
}

fn hstore(raw: &[u8]) -> Result<Value, DecodeError> {
    let mut rd = r(raw);
    let count = rd.i32()?.max(0);
    let mut map = Map::new();
    for _ in 0..count {
        let key = rd.value()?.ok_or("null hstore key")?;
        let key = std::str::from_utf8(key)?.to_string();
        let val = match rd.value()? {
            Some(v) => Value::String(std::str::from_utf8(v)?.to_string()),
            None => Value::Null,
        };
        map.insert(key, val);
    }
    Ok(Value::Object(map))
}

fn numeric(raw: &[u8]) -> Result<Value, DecodeError> {
    let mut rd = r(raw);
    let ndigits = rd.i16()?.max(0) as usize;
    let weight = rd.i16()? as i32;
    let sign = rd.u16()?;
    let dscale = rd.u16()? as usize;
    match sign {
        0xC000 => return Ok(Value::String("NaN".into())),
        0xD000 => return Ok(Value::String("Infinity".into())),
        0xF000 => return Ok(Value::String("-Infinity".into())),
        _ => {}
    }
    let mut digits = Vec::with_capacity(ndigits);
    for _ in 0..ndigits {
        digits.push(rd.i16()?);
    }
    let digit = |i: i32| -> i16 {
        if i >= 0 && (i as usize) < digits.len() {
            digits[i as usize]
        } else {
            0
        }
    };
    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-');
    }
    if weight < 0 {
        s.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                let _ = write!(s, "{}", digit(i));
            } else {
                let _ = write!(s, "{:04}", digit(i));
            }
        }
    }
    if dscale > 0 {
        let mut frac = String::new();
        let mut i = weight + 1;
        while frac.len() < dscale {
            let _ = write!(frac, "{:04}", digit(i));
            i += 1;
        }
        frac.truncate(dscale);
        s.push('.');
        s.push_str(&frac);
    }
    Ok(numeric_value(s))
}

/// A decimal string as a JSON number when a double holds it exactly enough
/// (15 significant digits), else kept as a string.
pub fn numeric_value(s: String) -> Value {
    // Trailing fractional zeros are scale, not precision.
    let t = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.') } else { s.as_str() };
    let significant = t.chars().filter(|c| c.is_ascii_digit()).skip_while(|c| *c == '0').count();
    if significant <= 15 {
        if !t.contains('.') {
            if let Ok(i) = t.parse::<i64>() {
                return Value::Number(i.into());
            }
        }
        if let Some(n) = t.parse::<f64>().ok().and_then(Number::from_f64) {
            return Value::Number(n);
        }
    }
    Value::String(s)
}

fn pg_epoch() -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(2000, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap()
}

fn date(days: i32) -> String {
    match days {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        d => (pg_epoch().date() + chrono::Duration::days(d as i64)).format("%Y-%m-%d").to_string(),
    }
}

fn timestamp(micros: i64, tz: bool) -> String {
    match micros {
        i64::MAX => "infinity".into(),
        i64::MIN => "-infinity".into(),
        m => {
            let t = pg_epoch() + chrono::Duration::microseconds(m);
            let base = t.format("%Y-%m-%dT%H:%M:%S%.f").to_string();
            if tz {
                format!("{base}Z")
            } else {
                base
            }
        }
    }
}

fn time_of_day(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000);
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    let mut out = format!("{h:02}:{m:02}:{s:02}");
    if frac > 0 {
        let f = format!("{frac:06}");
        out.push('.');
        out.push_str(f.trim_end_matches('0'));
    }
    out
}

fn offset(east_secs: i32) -> String {
    let sign = if east_secs < 0 { '-' } else { '+' };
    let a = east_secs.abs();
    let (h, m, s) = (a / 3600, (a / 60) % 60, a % 60);
    if s != 0 {
        format!("{sign}{h:02}:{m:02}:{s:02}")
    } else {
        format!("{sign}{h:02}:{m:02}")
    }
}

/// Postgres-style interval text ("1 year 2 mons 3 days 04:05:06"), which is
/// also valid interval input.
pub fn interval(months: i32, days: i32, micros: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let (years, mons) = (months / 12, months % 12);
    let unit = |n: i64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    if years != 0 {
        parts.push(unit(years as i64, "year", "years"));
    }
    if mons != 0 {
        parts.push(unit(mons as i64, "mon", "mons"));
    }
    if days != 0 {
        parts.push(unit(days as i64, "day", "days"));
    }
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        parts.push(format!("{sign}{}", time_of_day(micros.abs())));
    }
    parts.join(" ")
}

fn inet(raw: &[u8]) -> Result<String, DecodeError> {
    let mut rd = r(raw);
    let family = rd.u8()?;
    let bits = rd.u8()?;
    let is_cidr = rd.u8()? != 0;
    let nb = rd.u8()? as usize;
    let addr = rd.take(nb)?;
    let (ip, max) = match family {
        2 if nb == 4 => (std::net::IpAddr::from(<[u8; 4]>::try_from(addr)?).to_string(), 32),
        3 if nb == 16 => (std::net::IpAddr::from(<[u8; 16]>::try_from(addr)?).to_string(), 128),
        _ => return Err("bad inet".into()),
    };
    Ok(if is_cidr || bits != max { format!("{ip}/{bits}") } else { ip })
}

fn array(member: &Type, raw: &[u8]) -> Result<Value, DecodeError> {
    let mut rd = r(raw);
    let ndim = rd.i32()?.max(0) as usize;
    let _has_null = rd.i32()?;
    let _elem = rd.u32()?;
    if ndim == 0 {
        return Ok(Value::Array(Vec::new()));
    }
    let mut dims = Vec::with_capacity(ndim);
    for _ in 0..ndim {
        let len = rd.i32()?.max(0) as usize;
        let _lower = rd.i32()?;
        dims.push(len);
    }
    fn build(rd: &mut Reader<'_>, member: &Type, dims: &[usize]) -> Result<Value, DecodeError> {
        let mut out = Vec::with_capacity(dims[0]);
        for _ in 0..dims[0] {
            if dims.len() > 1 {
                out.push(build(rd, member, &dims[1..])?);
            } else {
                out.push(match rd.value()? {
                    None => Value::Null,
                    Some(b) => decode(member, b).unwrap_or_else(|_| hex(b)),
                });
            }
        }
        Ok(Value::Array(out))
    }
    build(&mut rd, member, &dims)
}

fn range(sub: &Type, raw: &[u8]) -> Result<String, DecodeError> {
    const EMPTY: u8 = 0x01;
    const LB_INC: u8 = 0x02;
    const UB_INC: u8 = 0x04;
    const LB_INF: u8 = 0x08;
    const UB_INF: u8 = 0x10;
    let mut rd = r(raw);
    let flags = rd.u8()?;
    if flags & EMPTY != 0 {
        return Ok("empty".into());
    }
    let bound = |rd: &mut Reader<'_>| -> Result<String, DecodeError> {
        let len = rd.i32()?.max(0) as usize;
        let b = rd.take(len)?;
        Ok(match decode(sub, b)? {
            Value::String(s) => {
                if s.contains([',', ' ', '(', ')', '[', ']', '"']) {
                    format!("\"{}\"", s.replace('"', "\\\""))
                } else {
                    s
                }
            }
            other => other.to_string(),
        })
    };
    let lower = if flags & LB_INF == 0 { bound(&mut rd)? } else { String::new() };
    let upper = if flags & UB_INF == 0 { bound(&mut rd)? } else { String::new() };
    Ok(format!(
        "{}{lower},{upper}{}",
        if flags & LB_INC != 0 { '[' } else { '(' },
        if flags & UB_INC != 0 { ']' } else { ')' }
    ))
}

fn tsvector(raw: &[u8]) -> Result<String, DecodeError> {
    let mut rd = r(raw);
    let count = rd.i32()?.max(0);
    let mut out = Vec::new();
    for _ in 0..count {
        let end = rd.buf.iter().position(|b| *b == 0).ok_or("bad tsvector")?;
        let word = std::str::from_utf8(rd.take(end)?)?.replace('\'', "''");
        rd.take(1)?;
        let npos = rd.u16()?;
        let mut positions = Vec::new();
        for _ in 0..npos {
            let p = rd.u16()?;
            let weight = match p >> 14 {
                3 => "A",
                2 => "B",
                1 => "C",
                _ => "",
            };
            positions.push(format!("{}{weight}", p & 0x3FFF));
        }
        if positions.is_empty() {
            out.push(format!("'{word}'"));
        } else {
            out.push(format!("'{word}':{}", positions.join(",")));
        }
    }
    Ok(out.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numeric_bytes(ndigits: &[i16], weight: i16, sign: u16, dscale: u16) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend((ndigits.len() as i16).to_be_bytes());
        b.extend(weight.to_be_bytes());
        b.extend(sign.to_be_bytes());
        b.extend(dscale.to_be_bytes());
        for d in ndigits {
            b.extend(d.to_be_bytes());
        }
        b
    }

    #[test]
    fn numerics() {
        // 12345.678
        assert_eq!(numeric(&numeric_bytes(&[1, 2345, 6780], 1, 0, 3)).unwrap(), serde_json::json!(12345.678));
        // -0.5
        assert_eq!(numeric(&numeric_bytes(&[5000], -1, 0x4000, 1)).unwrap(), serde_json::json!(-0.5));
        // 0.00005
        assert_eq!(numeric(&numeric_bytes(&[5000], -2, 0, 5)).unwrap(), serde_json::json!(0.00005));
        // 100 (integral)
        assert_eq!(numeric(&numeric_bytes(&[100], 0, 0, 0)).unwrap(), serde_json::json!(100));
        // 20 significant digits stay a string
        let big = numeric(&numeric_bytes(&[1234, 5678, 9012, 3456, 7890], 4, 0, 0)).unwrap();
        assert_eq!(big, serde_json::json!("12345678901234567890"));
        assert_eq!(numeric(&numeric_bytes(&[], 0, 0xC000, 0)).unwrap(), serde_json::json!("NaN"));
    }

    #[test]
    fn big_ints_become_strings() {
        assert_eq!(int(42), serde_json::json!(42));
        assert_eq!(int(9_007_199_254_740_993), serde_json::json!("9007199254740993"));
    }

    #[test]
    fn times() {
        assert_eq!(date(0), "2000-01-01");
        assert_eq!(timestamp(1_500_000, true), "2000-01-01T00:00:01.500Z");
        assert_eq!(time_of_day(3_723_000_001), "01:02:03.000001");
        assert_eq!(interval(14, 3, 3_600_000_000), "1 year 2 mons 3 days 01:00:00");
        assert_eq!(interval(0, 0, 0), "00:00:00");
        assert_eq!(interval(0, -1, 0), "-1 days");
        assert_eq!(offset(-18000), "-05:00");
    }

    #[test]
    fn inet_forms() {
        assert_eq!(inet(&[2, 32, 0, 4, 10, 0, 0, 1]).unwrap(), "10.0.0.1");
        assert_eq!(inet(&[2, 24, 1, 4, 10, 0, 0, 0]).unwrap(), "10.0.0.0/24");
    }

    #[test]
    fn int_array() {
        let mut b = Vec::new();
        b.extend(1i32.to_be_bytes()); // ndim
        b.extend(1i32.to_be_bytes()); // has null
        b.extend(23u32.to_be_bytes()); // int4
        b.extend(3i32.to_be_bytes()); // len
        b.extend(1i32.to_be_bytes()); // lower
        for v in [Some(1i32), None, Some(3)] {
            match v {
                Some(v) => {
                    b.extend(4i32.to_be_bytes());
                    b.extend(v.to_be_bytes());
                }
                None => b.extend((-1i32).to_be_bytes()),
            }
        }
        assert_eq!(array(&Type::INT4, &b).unwrap(), serde_json::json!([1, null, 3]));
    }

    #[test]
    fn unknown_binary_is_hex() {
        assert_eq!(text_or_hex(&[0, 1, 2]), serde_json::json!("\\x000102"));
        assert_eq!(text_or_hex(b"plain"), serde_json::json!("plain"));
    }
}
