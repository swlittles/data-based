//! AI assistant proxy. OpenRouter is the only provider: one key reaches every
//! model it routes to. The key lives in the same AES-256-GCM vault as
//! connection secrets and never leaves the backend - the webview only learns
//! whether one is set.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};

const API_BASE: &str = "https://openrouter.ai/api/v1";
const KEY_FILE: &str = "ai_key.json";
const REFERER: &str = "https://github.com/swlittles/mongo-bongo";
const TITLE: &str = "Mongo Bongo";
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
const META_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResult {
    pub content: String,
    /// The model that actually answered (OpenRouter may route `openrouter/auto`).
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    /// Credits spent, when OpenRouter reports it.
    pub cost: Option<f64>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    /// USD per million prompt / completion tokens.
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
    pub reasoning: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyInfo {
    pub label: String,
    pub usage: f64,
    pub limit: Option<f64>,
    pub free_tier: bool,
}

// ---------------------------------------------------------------------------
// key vault
// ---------------------------------------------------------------------------

fn key_path(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join(KEY_FILE)
}

fn stored_key(state: &AppState) -> Option<String> {
    let raw = std::fs::read_to_string(key_path(state)).ok()?;
    let file: Value = serde_json::from_str(&raw).ok()?;
    let payload = file.get("openrouter")?.as_str()?;
    state.crypto().decrypt(payload).ok().filter(|k| !k.trim().is_empty())
}

fn require_key(state: &AppState) -> AppResult<String> {
    stored_key(state)
        .ok_or_else(|| AppError::Other("Add your OpenRouter API key in Settings > AI first".into()))
}

/// Whether an OpenRouter key is stored. The key itself never leaves the backend.
#[tauri::command]
pub fn ai_status(state: State<'_, AppState>) -> AiStatus {
    AiStatus { configured: stored_key(&state).is_some() }
}

/// Store the OpenRouter key encrypted, or remove it when `key` is blank.
#[tauri::command]
pub fn set_ai_key(key: String, state: State<'_, AppState>) -> AppResult<AiStatus> {
    let key = key.trim();
    let path = key_path(&state);
    if key.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        return Ok(AiStatus { configured: false });
    }
    let payload = state.crypto().encrypt(key)?;
    let json = serde_json::to_string_pretty(&json!({ "openrouter": payload }))?;
    std::fs::write(&path, json)
        .map_err(|e| AppError::Storage(format!("could not write the AI key: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(AiStatus { configured: true })
}

// ---------------------------------------------------------------------------
// OpenRouter calls
// ---------------------------------------------------------------------------

fn client(timeout: Duration) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))
}

fn with_headers(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    req.bearer_auth(key)
        .header("HTTP-Referer", REFERER)
        .header("X-Title", TITLE)
}

async fn read_json(resp: reqwest::Response) -> AppResult<(reqwest::StatusCode, Value)> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Other(format!("OpenRouter response unreadable: {e}")))?;
    let payload = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "error": { "message": text } }));
    Ok((status, payload))
}

fn error_message(payload: &Value) -> Option<String> {
    payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/error").and_then(Value::as_str))
        .map(|m| m.trim().chars().take(400).collect())
}

fn check_status(status: reqwest::StatusCode, payload: &Value) -> AppResult<()> {
    if status.is_success() {
        return Ok(());
    }
    let msg = error_message(payload).unwrap_or_else(|| "unknown error".into());
    let hint = match status.as_u16() {
        401 => " - check the API key in Settings > AI",
        402 => " - add credits to your OpenRouter account",
        429 => " - rate limited, try again shortly",
        _ => "",
    };
    Err(AppError::Other(format!("OpenRouter ({status}): {msg}{hint}")))
}

/// Request body for a chat completion. Deep mode asks for high reasoning
/// effort; OpenRouter drops parameters a model does not support.
fn chat_body(model: &str, system: &str, user: &str, json_mode: bool, reasoning: bool) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "reasoning": { "effort": if reasoning { "high" } else { "low" }, "exclude": true },
        "usage": { "include": true },
    });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    body
}

fn parse_chat(payload: &Value, requested_model: &str) -> AppResult<AiChatResult> {
    // OpenRouter can report a provider failure inside a 200 response.
    if let Some(msg) = error_message(payload) {
        return Err(AppError::Other(format!("OpenRouter: {msg}")));
    }
    if let Some(msg) = payload.pointer("/choices/0/error/message").and_then(Value::as_str) {
        return Err(AppError::Other(format!("OpenRouter: {msg}")));
    }
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            let reason = payload
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                .unwrap_or("no content");
            AppError::Other(format!("the model returned an empty answer ({reason}) - try again or pick another model"))
        })?;
    let n = |k: &str| payload.pointer(&format!("/usage/{k}")).and_then(Value::as_u64).unwrap_or(0);
    let (input, output) = (n("prompt_tokens"), n("completion_tokens"));
    let total = match n("total_tokens") {
        0 => input + output,
        t => t,
    };
    Ok(AiChatResult {
        content,
        model: payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(requested_model)
            .to_string(),
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cost: payload.pointer("/usage/cost").and_then(Value::as_f64),
    })
}

/// One system + user turn against the chosen model. Returns the answer text
/// plus token usage and cost.
#[tauri::command]
pub async fn ai_chat(
    model: String,
    system: String,
    user: String,
    json_mode: bool,
    reasoning: bool,
    state: State<'_, AppState>,
) -> AppResult<AiChatResult> {
    let key = require_key(&state)?;
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Other("Pick a model in Settings > AI".into()));
    }
    let body = chat_body(model, &system, &user, json_mode, reasoning);
    let resp = with_headers(client(CHAT_TIMEOUT)?.post(format!("{API_BASE}/chat/completions")), &key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("OpenRouter request failed: {e}")))?;
    let (status, payload) = read_json(resp).await?;
    check_status(status, &payload)?;
    parse_chat(&payload, model)
}

/// Per-token price string ("0.000003") to USD per million tokens.
fn per_million(v: Option<&Value>) -> Option<f64> {
    let per_token = match v? {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (per_token >= 0.0).then(|| per_token * 1_000_000.0)
}

fn parse_models(payload: &Value) -> Vec<AiModel> {
    let mut models: Vec<AiModel> = payload
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?.to_string();
                    let takes_text = m
                        .pointer("/architecture/output_modalities")
                        .and_then(Value::as_array)
                        .map_or(true, |mods| mods.iter().any(|x| x.as_str() == Some("text")));
                    if !takes_text {
                        return None;
                    }
                    Some(AiModel {
                        name: m.get("name").and_then(Value::as_str).unwrap_or(&id).to_string(),
                        context_length: m.get("context_length").and_then(Value::as_u64).unwrap_or(0),
                        prompt_price: per_million(m.pointer("/pricing/prompt")),
                        completion_price: per_million(m.pointer("/pricing/completion")),
                        reasoning: m
                            .get("supported_parameters")
                            .and_then(Value::as_array)
                            .is_some_and(|p| p.iter().any(|x| x.as_str() == Some("reasoning"))),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

/// Models OpenRouter currently offers, for the model picker.
#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>) -> AppResult<Vec<AiModel>> {
    let mut req = client(META_TIMEOUT)?.get(format!("{API_BASE}/models"));
    if let Some(key) = stored_key(&state) {
        req = with_headers(req, &key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Other(format!("could not reach OpenRouter: {e}")))?;
    let (status, payload) = read_json(resp).await?;
    check_status(status, &payload)?;
    Ok(parse_models(&payload))
}

fn parse_key_info(payload: &Value) -> AiKeyInfo {
    let d = payload.get("data").unwrap_or(payload);
    AiKeyInfo {
        label: d.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
        usage: d.get("usage").and_then(Value::as_f64).unwrap_or(0.0),
        limit: d.get("limit").and_then(Value::as_f64),
        free_tier: d.get("is_free_tier").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// Validate the stored key and report its usage / limit.
#[tauri::command]
pub async fn ai_key_info(state: State<'_, AppState>) -> AppResult<AiKeyInfo> {
    let key = require_key(&state)?;
    let resp = with_headers(client(META_TIMEOUT)?.get(format!("{API_BASE}/key")), &key)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("could not reach OpenRouter: {e}")))?;
    let (status, payload) = read_json(resp).await?;
    check_status(status, &payload)?;
    Ok(parse_key_info(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_body_modes() {
        let b = chat_body("openrouter/auto", "sys", "hi", true, false);
        assert_eq!(b["model"], "openrouter/auto");
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        assert_eq!(b["response_format"]["type"], "json_object");
        assert_eq!(b["reasoning"]["effort"], "low");
        let deep = chat_body("m", "s", "u", false, true);
        assert_eq!(deep["reasoning"]["effort"], "high");
        assert!(deep.get("response_format").is_none());
    }

    #[test]
    fn parses_chat_answer_and_usage() {
        let p = json!({
            "model": "anthropic/claude-sonnet-5",
            "choices": [{ "message": { "content": "{\"ok\":true}" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150, "cost": 0.0012 }
        });
        let r = parse_chat(&p, "openrouter/auto").unwrap();
        assert_eq!(r.content, "{\"ok\":true}");
        assert_eq!(r.model, "anthropic/claude-sonnet-5");
        assert_eq!((r.input_tokens, r.output_tokens, r.total_tokens), (120, 30, 150));
        assert_eq!(r.cost, Some(0.0012));
    }

    #[test]
    fn chat_errors_surface() {
        let err = parse_chat(&json!({ "error": { "message": "No endpoints found" } }), "x").unwrap_err();
        assert!(err.to_string().contains("No endpoints found"));
        let empty = json!({ "choices": [{ "message": { "content": "" }, "finish_reason": "length" }] });
        assert!(parse_chat(&empty, "x").unwrap_err().to_string().contains("length"));
        let inner = json!({ "choices": [{ "error": { "message": "provider down" } }] });
        assert!(parse_chat(&inner, "x").unwrap_err().to_string().contains("provider down"));
    }

    #[test]
    fn status_hints() {
        let p = json!({ "error": { "message": "Invalid key" } });
        let e = check_status(reqwest::StatusCode::UNAUTHORIZED, &p).unwrap_err().to_string();
        assert!(e.contains("Invalid key") && e.contains("Settings > AI"));
        assert!(check_status(reqwest::StatusCode::OK, &p).is_ok());
    }

    #[test]
    fn parses_models() {
        let p = json!({ "data": [
            { "id": "z/text", "name": "Z", "context_length": 128000,
              "pricing": { "prompt": "0.000003", "completion": "0.000015" },
              "supported_parameters": ["reasoning", "response_format"],
              "architecture": { "output_modalities": ["text"] } },
            { "id": "a/image-only", "architecture": { "output_modalities": ["image"] } },
            { "id": "b/free", "pricing": { "prompt": "0", "completion": "0" } },
            { "id": "c/router", "pricing": { "prompt": "-1", "completion": "-1" } }
        ]});
        let m = parse_models(&p);
        assert_eq!(m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["b/free", "c/router", "z/text"]);
        let z = &m[2];
        assert_eq!(z.context_length, 128000);
        assert!((z.prompt_price.unwrap() - 3.0).abs() < 1e-9);
        assert!((z.completion_price.unwrap() - 15.0).abs() < 1e-9);
        assert!(z.reasoning);
        assert_eq!(m[0].prompt_price, Some(0.0));
        assert_eq!(m[1].prompt_price, None);
        assert_eq!(m[0].name, "b/free");
    }

    #[test]
    fn parses_key_info() {
        let k = parse_key_info(&json!({ "data": { "label": "sk-or-v1-abc...", "usage": 1.5, "limit": null, "is_free_tier": false } }));
        assert_eq!(k, AiKeyInfo { label: "sk-or-v1-abc...".into(), usage: 1.5, limit: None, free_tier: false });
    }
}
