//! Claude API HTTP 호출·SSE 파서·오류 변환(계약-AI 2·4.1절). 공식 Rust SDK가 없어 직접 구현한다.
use crate::error::{AppError, AppResult, ErrorKind};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, Response};
use serde_json::Value;
use std::time::Duration;

const BASE: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2026-10-21";

/// 앱 전체에서 1개. 유휴 상태에서는 연결을 열지 않는다(NF-04).
pub fn build_client() -> AppResult<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // 조각 사이 간격. 서버가 ping을 보내므로 긴 답도 끊기지 않는다. 전체 timeout은 걸지 않는다.
        .read_timeout(Duration::from_secs(60))
        .https_only(true)
        // 다른 호스트로 넘겨질 때 x-api-key가 따라가지 않게 redirect는 따르지 않는다.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::new(ErrorKind::AiApi, format!("HTTP 클라이언트 생성 실패: {e}")))
}

fn headers(key: &str) -> AppResult<HeaderMap> {
    let mut key = HeaderValue::from_str(key).map_err(|_| AppError::new(ErrorKind::InvalidInput, "API 키 형식이 잘못되었습니다"))?;
    key.set_sensitive(true);
    let mut h = HeaderMap::new();
    h.insert("x-api-key", key);
    h.insert("anthropic-version", HeaderValue::from_static(API_VERSION));
    Ok(h)
}

/// 키 확인용 시험 호출(크레딧을 쓰지 않음, 계약-AI 1.4).
pub async fn check_key(client: &Client, key: &str) -> AppResult<()> {
    let res = client
        .get(format!("{BASE}/v1/models?limit=1"))
        .headers(headers(key)?)
        .send()
        .await
        .map_err(send_err)?;
    if res.status().is_success() { Ok(()) } else { Err(status_err(res).await) }
}

pub struct Outcome {
    pub text: String,
    /// API `stop_reason` 원문. `message_delta`에 없었으면 `"unknown"`(계약-AI 4절).
    pub stop_reason: String,
}

/// `/v1/messages`를 스트리밍으로 부른다. 200 응답이 시작되면 `on_started`를 부르고,
/// 받은 네트워크 청크마다 그 안의 텍스트 조각을 이어 붙여 `on_delta`를 한 번 부른다(IPC 횟수를 줄임).
pub async fn stream_message(
    client: &Client,
    key: &str,
    body: &Value,
    on_started: impl FnOnce(),
    mut on_delta: impl FnMut(&str),
) -> AppResult<Outcome> {
    let mut res = client
        .post(format!("{BASE}/v1/messages"))
        .headers(headers(key)?)
        .json(body)
        .send()
        .await
        .map_err(send_err)?;
    if !res.status().is_success() {
        return Err(status_err(res).await);
    }
    on_started();
    let request_id = header_str(&res, "request-id");
    let mut parser = SseParser::default();
    let mut out = Outcome { text: String::new(), stop_reason: "unknown".into() };
    while let Some(chunk) = res.chunk().await.map_err(read_err)? {
        let from = out.text.len();
        let mut done = false;
        for ev in parser.push(&chunk) {
            match handle_event(&ev, &request_id)? {
                Step::Delta(t) => out.text.push_str(&t),
                Step::Stop(reason) => out.stop_reason = reason,
                Step::Done => done = true,
                Step::Skip => {}
            }
            if done {
                break;
            }
        }
        if out.text.len() > from {
            on_delta(&out.text[from..]);
        }
        if done {
            return Ok(out);
        }
    }
    Err(AppError::new(ErrorKind::AiApi, format!("응답이 중간에 끊겼습니다 (request-id {request_id})")))
}

#[derive(Debug, PartialEq)]
enum Step {
    Delta(String),
    Stop(String),
    Done,
    Skip,
}

fn handle_event(ev: &SseEvent, request_id: &str) -> AppResult<Step> {
    let data = || serde_json::from_str::<Value>(&ev.data).unwrap_or(Value::Null);
    Ok(match ev.event.as_str() {
        "content_block_delta" => {
            let d = data();
            match (d["delta"]["type"].as_str(), d["delta"]["text"].as_str()) {
                // thinking_delta·signature_delta 등은 버린다.
                (Some("text_delta"), Some(t)) => Step::Delta(t.to_owned()),
                _ => Step::Skip,
            }
        }
        "message_delta" => match data()["delta"]["stop_reason"].as_str() {
            Some(r) => Step::Stop(r.to_owned()),
            None => Step::Skip,
        },
        "message_stop" => Step::Done,
        "error" => {
            let d = data();
            let t = d["error"]["type"].as_str().unwrap_or("unknown");
            return Err(AppError::new(classify_type(t), format!("스트림 오류 {t} (request-id {request_id})")));
        }
        // ping과 모르는 이벤트는 버린다(API는 이벤트 종류를 늘릴 수 있음).
        _ => Step::Skip,
    })
}

fn send_err(e: reqwest::Error) -> AppError {
    if e.is_connect() {
        AppError::new(ErrorKind::Offline, "API 서버에 연결할 수 없습니다")
    } else if e.is_timeout() {
        AppError::new(ErrorKind::AiTimeout, "응답 시간이 초과되었습니다")
    } else {
        AppError::new(ErrorKind::AiApi, format!("요청 실패: {}", e.without_url()))
    }
}

fn read_err(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::new(ErrorKind::AiTimeout, "응답 시간이 초과되었습니다")
    } else {
        AppError::new(ErrorKind::AiApi, format!("응답 읽기 실패: {}", e.without_url()))
    }
}

fn header_str(res: &Response, name: &str) -> String {
    res.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("-").to_owned()
}

/// 2xx가 아닌 응답. message에는 상태·오류 type·request-id만 넣는다(본문 없음).
async fn status_err(res: Response) -> AppError {
    let status = res.status().as_u16();
    let request_id = header_str(&res, "request-id");
    let retry_after = res.headers().contains_key("retry-after");
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let t = body["error"]["type"].as_str().unwrap_or("unknown");
    let kind = classify(status, t, body["error"]["message"].as_str().unwrap_or(""), retry_after);
    AppError::new(kind, format!("{status} {t} (request-id {request_id})"))
}

/// 계약-AI 4.1 표. 상태 코드로 정해지지 않으면 오류 type으로 고른다.
pub fn classify(status: u16, err_type: &str, err_msg: &str, has_retry_after: bool) -> ErrorKind {
    use ErrorKind::*;
    match status {
        401 | 403 => AiAuth,
        402 => AiCredit,
        400 if err_msg.to_ascii_lowercase().contains("credit balance") => AiCredit,
        429 if has_retry_after => AiRateLimit,
        // retry-after 없는 429는 월 지출 상한으로 본다.
        429 => AiCredit,
        504 => AiTimeout,
        529 => AiOverloaded,
        _ => classify_type(err_type),
    }
}

/// 오류 type만으로 고른다(200 응답 뒤 스트림 중 `error` 이벤트도 이것을 쓴다).
fn classify_type(err_type: &str) -> ErrorKind {
    use ErrorKind::*;
    match err_type {
        "authentication_error" | "permission_error" => AiAuth,
        "billing_error" => AiCredit,
        "rate_limit_error" => AiRateLimit,
        "overloaded_error" => AiOverloaded,
        "timeout_error" => AiTimeout,
        _ => AiApi,
    }
}

#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// 빈 줄로 이벤트를 나누고 `event:`·`data:` 줄을 읽는다. 조각이 이벤트·UTF-8 문자 중간에서 끊겨도 된다.
/// 줄끝 `\r\n`·`\r`·`\n`은 모두 `\n`으로 바꾼다(`\r\n`이 조각 경계에서 갈려도 한 줄끝).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    after_cr: bool,
    /// `buf`에서 빈 줄을 이미 찾아 본 길이. 긴 이벤트가 여러 청크로 와도 앞부분을 다시 훑지 않는다.
    scanned: usize,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        for &b in chunk {
            if !(self.after_cr && b == b'\n') {
                self.buf.push(if b == b'\r' { b'\n' } else { b });
            }
            self.after_cr = b == b'\r';
        }
        let mut out = Vec::new();
        // 다 읽은 이벤트는 끝에 한 번에 지운다(이벤트마다 남은 버퍼를 앞으로 당기지 않게).
        let mut start = 0;
        while let Some(pos) = self.buf[self.scanned..].windows(2).position(|w| w == b"\n\n") {
            let end = self.scanned + pos;
            if let Some(ev) = parse_block(&String::from_utf8_lossy(&self.buf[start..end])) {
                out.push(ev);
            }
            start = end + 2;
            self.scanned = start;
        }
        self.buf.drain(..start);
        self.scanned = self.buf.len().saturating_sub(1);
        out
    }
}

fn parse_block(block: &str) -> Option<SseEvent> {
    let (mut event, mut data) = (String::new(), Vec::new());
    for line in block.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = value.to_owned(),
            "data" => data.push(value),
            _ => {}
        }
    }
    if event.is_empty() && data.is_empty() {
        return None;
    }
    if event.is_empty() {
        event = "message".into();
    }
    Some(SseEvent { event, data: data.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent { event: event.into(), data: data.into() }
    }

    #[test]
    fn sse_split_anywhere() {
        let raw = "event: ping\ndata: {\"type\":\"ping\"}\n\nevent: content_block_delta\r\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"안녕\"}}\r\n\r\n: 주석\n\n";
        let bytes = raw.as_bytes();
        // 모든 위치에서 둘로 잘라도(UTF-8 문자 중간 포함) 결과가 같아야 한다.
        for cut in 0..=bytes.len() {
            let mut p = SseParser::default();
            let mut got = p.push(&bytes[..cut]);
            got.extend(p.push(&bytes[cut..]));
            assert_eq!(
                got,
                vec![
                    ev("ping", "{\"type\":\"ping\"}"),
                    ev("content_block_delta", "{\"delta\":{\"type\":\"text_delta\",\"text\":\"안녕\"}}"),
                ],
                "cut {cut}"
            );
        }
    }

    #[test]
    fn sse_multiline_data_and_default_event() {
        let mut p = SseParser::default();
        assert_eq!(p.push(b"data: a\ndata: b\n\n"), vec![ev("message", "a\nb")]);
        assert_eq!(p.push(b"event: x\ndata: 1"), vec![]);
    }

    #[test]
    fn sse_cr_only_line_endings() {
        let raw = b"event: a\rdata: 1\r\revent: b\r\ndata: 2\r\n\r\n";
        for cut in 0..=raw.len() {
            let mut p = SseParser::default();
            let mut got = p.push(&raw[..cut]);
            got.extend(p.push(&raw[cut..]));
            assert_eq!(got, vec![ev("a", "1"), ev("b", "2")], "cut {cut}");
        }
    }

    #[test]
    fn events_to_steps() {
        let r = "req_1";
        let step = |e: &str, d: &str| handle_event(&ev(e, d), r);
        assert_eq!(
            step("content_block_delta", r#"{"delta":{"type":"text_delta","text":"hi"}}"#).unwrap(),
            Step::Delta("hi".into())
        );
        assert_eq!(step("content_block_delta", r#"{"delta":{"type":"thinking_delta","thinking":"x"}}"#).unwrap(), Step::Skip);
        assert_eq!(step("content_block_delta", r#"{"delta":{"type":"signature_delta","signature":"x"}}"#).unwrap(), Step::Skip);
        assert_eq!(
            step("message_delta", r#"{"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}"#).unwrap(),
            Step::Stop("max_tokens".into())
        );
        assert_eq!(step("message_stop", "{}").unwrap(), Step::Done);
        assert_eq!(step("ping", "{}").unwrap(), Step::Skip);
        assert_eq!(step("brand_new_event", "{}").unwrap(), Step::Skip);
        assert_eq!(step("content_block_delta", "not json").unwrap(), Step::Skip);
        let e = step("error", r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).unwrap_err();
        assert_eq!(e.kind, ErrorKind::AiOverloaded);
        assert!(e.message.contains("req_1"));
        let e = step("error", r#"{"type":"error","error":{"type":"api_error","message":"x"}}"#).unwrap_err();
        assert_eq!(e.kind, ErrorKind::AiApi);
    }

    #[test]
    fn classify_table() {
        use ErrorKind::*;
        let cases = [
            (401, "authentication_error", "", false, AiAuth),
            (403, "permission_error", "", false, AiAuth),
            (402, "billing_error", "", false, AiCredit),
            (400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.", false, AiCredit),
            (400, "invalid_request_error", "max_tokens: too large", false, AiApi),
            (429, "rate_limit_error", "", true, AiRateLimit),
            (429, "rate_limit_error", "", false, AiCredit),
            (504, "timeout_error", "", false, AiTimeout),
            (529, "overloaded_error", "", false, AiOverloaded),
            (500, "api_error", "", false, AiApi),
            (404, "not_found_error", "", false, AiApi),
        ];
        for (s, t, m, ra, want) in cases {
            assert_eq!(classify(s, t, m, ra), want, "{s} {t} {m}");
        }
    }

    #[test]
    fn key_header_is_sensitive() {
        let h = headers("sk-test").unwrap();
        assert!(h["x-api-key"].is_sensitive());
        assert!(!format!("{h:?}").contains("sk-test"));
        assert_eq!(headers("bad\nkey").unwrap_err().kind, ErrorKind::InvalidInput);
    }
}
