//! AI·API 키 명령(계약-AI 1.4·2.6·3·4절). 검사 순서와 진행 중 요청(최대 1개)을 맡는다.
//! 키는 `secret`으로만 읽고 쓴다(NF-05). AI 사용 제어는 화면이 아니라 여기서 최종으로 막는다(NF-01).
mod client;
mod prompts;

use crate::commands::AppState;
use crate::db;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::secret;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;

/// 보낼 텍스트 전체의 Unicode 문자 수 상한(F-08.5).
const INPUT_LIMIT: usize = 20_000;

pub struct AiState {
    client: AppResult<reqwest::Client>,
    running: Mutex<Option<Running>>,
}

struct Running {
    id: String,
    handle: Option<JoinHandle<()>>,
    cancelled: bool,
}

impl AiState {
    pub fn new() -> Self {
        Self { client: client::build_client(), running: Mutex::new(None) }
    }

    fn client(&self) -> AppResult<reqwest::Client> {
        self.client.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 없는 id면 아무 일도 하지 않는다.
    fn cancel(&self, id: &str) {
        if let Some(r) = self.lock().as_mut().filter(|r| r.id == id) {
            r.cancelled = true;
            if let Some(h) = &r.handle {
                h.abort();
            }
        }
    }

    /// 동시 요청은 1개만(계약-AI 2.6). 돌려준 `Slot`이 사라지면 자리를 비운다.
    fn reserve(&self, id: &str) -> AppResult<Slot<'_>> {
        let mut g = self.lock();
        if g.is_some() {
            return Err(AppError::new(ErrorKind::AiBusy, "다른 AI 요청이 진행 중입니다"));
        }
        *g = Some(Running { id: id.to_owned(), handle: None, cancelled: false });
        Ok(Slot(self))
    }
}

struct Slot<'a>(&'a AiState);

impl Slot<'_> {
    fn attach(&self, handle: JoinHandle<()>) {
        if let Some(r) = self.0.lock().as_mut() {
            if r.cancelled {
                handle.abort();
            }
            r.handle = Some(handle);
        }
    }

    fn cancelled(&self) -> bool {
        self.0.lock().as_ref().is_some_and(|r| r.cancelled)
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.lock() = None;
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AiEvent {
    Delta { text: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResult {
    text: String,
    truncated: bool,
    /// API `stop_reason` 원문(없으면 `"unknown"`). 정상 완료는 `end_turn`·`stop_sequence`뿐(계약-AI 4절).
    stop_reason: String,
    input_chars: usize,
}

impl AiResult {
    fn new(o: client::Outcome, input_chars: usize) -> Self {
        Self { text: o.text, truncated: o.stop_reason == "max_tokens", stop_reason: o.stop_reason, input_chars }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    has_key: bool,
    excluded: db::ai::Excluded,
    exclude_mode: db::ai::ExcludeMode,
    today_calls: i64,
    daily_limit: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Deserialize)]
pub struct AiTurn {
    role: Role,
    text: String,
}

#[derive(Serialize)]
pub struct Last4 {
    last4: String,
}

#[derive(Serialize)]
pub struct KeyStatus {
    present: bool,
    last4: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Task {
    Summarize,
    Rewrite,
    Ask,
}

/// 모델·출력 상한·thinking은 Rust가 정한다(계약-AI 2.3, 화면이 바꿀 수 없음).
fn request_body(task: Task, messages: Vec<Value>) -> Value {
    let (model, max_tokens, thinking, system) = match task {
        Task::Summarize => ("claude-haiku-5-5", 1024, "disabled", prompts::SUMMARIZE_SYSTEM),
        // Sonnet은 disabled를 받지 않아 가장 낮은 설정을 쓴다.
        Task::Rewrite => ("claude-sonnet-5-5", 16_000, "between_tools", prompts::REWRITE_SYSTEM),
        Task::Ask => ("claude-sonnet-5-5", 4096, "between_tools", prompts::ASK_SYSTEM),
    };
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "thinking": { "type": thinking },
        "system": system,
        "messages": messages,
    })
}

fn invalid(m: &str) -> AppError {
    AppError::new(ErrorKind::InvalidInput, m)
}

fn user(content: String) -> Value {
    json!({ "role": "user", "content": content })
}

/// `history`는 user·assistant가 번갈아 오고 assistant로 끝나야 한다(그 뒤에 `question`을 user로 붙임).
fn ask_messages(context: &str, history: &[AiTurn], question: &str) -> AppResult<Vec<Value>> {
    if question.trim().is_empty() {
        return Err(invalid("질문이 비었습니다"));
    }
    if history.len() % 2 != 0 {
        return Err(invalid("이전 대화는 질문·답 쌍이어야 합니다"));
    }
    let mut out = Vec::with_capacity(history.len() + 1);
    for (i, t) in history.iter().enumerate() {
        let want_user = i % 2 == 0;
        if matches!(t.role, Role::User) != want_user {
            return Err(invalid("이전 대화의 순서가 잘못되었습니다"));
        }
        if t.text.trim().is_empty() {
            return Err(invalid("이전 대화에 빈 항목이 있습니다"));
        }
        let role = if want_user { "user" } else { "assistant" };
        out.push(json!({ "role": role, "content": t.text }));
    }
    out.push(user(question.to_owned()));
    // 노트 본문은 첫 user 메시지 앞에 둔다.
    let first = out[0]["content"].as_str().unwrap_or_default();
    out[0]["content"] = Value::String(prompts::ask_context(context) + first);
    Ok(out)
}

fn ask_input_chars(context: &str, history: &[AiTurn], question: &str) -> usize {
    context.chars().count() + history.iter().map(|t| t.text.chars().count()).sum::<usize>() + question.chars().count()
}

/// 보낼 메시지와 입력 글자 수. 명령이 입력 확인을 마치고 만든다.
struct Prompt {
    task: Task,
    messages: Vec<Value>,
    input_chars: usize,
}

/// 요약·다듬기: 텍스트 하나를 user 메시지 하나로 보낸다.
fn single(task: Task, text: &str) -> AppResult<Prompt> {
    let summarize = task == Task::Summarize;
    if text.trim().is_empty() {
        return Err(invalid(if summarize { "요약할 텍스트가 비었습니다" } else { "다듬을 텍스트가 비었습니다" }));
    }
    let content = if summarize { prompts::summarize_user(text) } else { prompts::rewrite_user(text) };
    Ok(Prompt { task, messages: vec![user(content)], input_chars: text.chars().count() })
}

/// 'YYYY-MM-DD' 모양만 본다(화면이 보낸 지역 날짜, 계약-AI 3절).
fn valid_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn check_day(s: &str) -> AppResult<()> {
    if valid_day(s) { Ok(()) } else { Err(invalid("today는 YYYY-MM-DD여야 합니다")) }
}

/// 전송 제외(자기 또는 '하위 포함'으로 제외한 조상). 키를 읽기 전에 검사한다.
fn check_excluded(app: &AppState, page_id: i64) -> AppResult<()> {
    match db::ai::exclusion(&*app.conn()?, page_id)? {
        db::ai::Excluded::None => Ok(()),
        _ => Err(AppError::new(ErrorKind::AiExcluded, "AI 전송 제외 페이지입니다")),
    }
}

/// 하루 호출 상한. `calls >= limit`이면 `AiDailyLimit`.
fn check_daily_limit(app: &AppState, today: &str) -> AppResult<()> {
    let conn = app.conn()?;
    let limit = db::ai::daily_limit(&conn)?;
    if db::ai::calls_on(&conn, today)? >= limit {
        return Err(AppError::new(ErrorKind::AiDailyLimit, format!("오늘 AI 호출 상한({limit}회)에 닿았습니다")));
    }
    Ok(())
}

/// API가 200으로 응답하기 시작한 요청 1회와 입력 글자 수를 `today`에 더한다(취소·중간 오류여도 센다).
/// 기록 실패로 받은 결과를 버리지는 않는다.
fn record_usage(app: &AppState, today: &str, input_chars: usize) {
    if let Err(e) = app.conn().and_then(|c| db::ai::record_usage(&c, today, input_chars as i64)) {
        eprintln!("AI 사용 기록 실패: {e}");
    }
}

/// 검사 순서(계약-AI 3절): 입력 확인 → 전송 제외 → 입력 길이 → 하루 상한 → 동시 요청 → 키 읽기 → 전송.
/// 입력 확인 중 텍스트 부분은 명령이 `Prompt`를 만들며 이미 마쳤다.
async fn run(
    app: &AppState,
    ai: &AiState,
    request_id: String,
    page_id: i64,
    today: String,
    prompt: Prompt,
    on_event: Channel<AiEvent>,
) -> AppResult<AiResult> {
    if request_id.is_empty() {
        return Err(invalid("requestId가 비었습니다"));
    }
    check_day(&today)?;
    let Prompt { task, messages, input_chars } = prompt;
    check_excluded(app, page_id)?;
    if input_chars > INPUT_LIMIT {
        return Err(AppError::new(
            ErrorKind::InputTooLong,
            format!("입력이 {INPUT_LIMIT}자를 넘습니다({input_chars}자)"),
        ));
    }
    check_daily_limit(app, &today)?;
    let slot = ai.reserve(&request_id)?;
    let Some(key) = secret::load()? else {
        // 사용자가 자격 증명 관리자에서 직접 지운 경우. 화면 표시도 맞춘다.
        if let Ok(conn) = app.conn() {
            let _ = db::ai::set_key_last4(&conn, None);
        }
        return Err(AppError::new(ErrorKind::NoApiKey, "API 키가 없습니다"));
    };
    let http = ai.client()?;
    let body = request_body(task, messages);
    let started = Arc::new(AtomicBool::new(false));
    let started_in = started.clone();
    // 취소(abort)되면 tx가 버려져 rx가 None을 받는다. 응답도 버려져 연결이 닫힌다.
    let (tx, mut rx) = async_runtime::channel(1);
    let handle = async_runtime::spawn(async move {
        let r = client::stream_message(
            &http,
            &key,
            &body,
            || started_in.store(true, Ordering::SeqCst),
            |t| {
                let _ = on_event.send(AiEvent::Delta { text: t.to_owned() });
            },
        )
        .await;
        let _ = tx.send(r).await;
    });
    slot.attach(handle);
    let result = rx.recv().await;
    if started.load(Ordering::SeqCst) {
        record_usage(app, &today, input_chars);
    }
    match result {
        Some(r) => r.map(|o| AiResult::new(o, input_chars)),
        None if slot.cancelled() => Err(AppError::new(ErrorKind::Cancelled, "중지했습니다")),
        None => Err(AppError::new(ErrorKind::AiApi, "AI 작업이 비정상 종료되었습니다")),
    }
}

type A<'a> = State<'a, AppState>;
type Ai<'a> = State<'a, AiState>;

#[tauri::command]
pub async fn ai_summarize(
    app: A<'_>,
    ai: Ai<'_>,
    request_id: String,
    page_id: i64,
    text: String,
    today: String,
    on_event: Channel<AiEvent>,
) -> AppResult<AiResult> {
    let prompt = single(Task::Summarize, &text)?;
    run(&app, &ai, request_id, page_id, today, prompt, on_event).await
}

#[tauri::command]
pub async fn ai_rewrite(
    app: A<'_>,
    ai: Ai<'_>,
    request_id: String,
    page_id: i64,
    text: String,
    today: String,
    on_event: Channel<AiEvent>,
) -> AppResult<AiResult> {
    let prompt = single(Task::Rewrite, &text)?;
    run(&app, &ai, request_id, page_id, today, prompt, on_event).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_ask(
    app: A<'_>,
    ai: Ai<'_>,
    request_id: String,
    page_id: i64,
    context: String,
    history: Vec<AiTurn>,
    question: String,
    today: String,
    on_event: Channel<AiEvent>,
) -> AppResult<AiResult> {
    let prompt = Prompt {
        task: Task::Ask,
        messages: ask_messages(&context, &history, &question)?,
        input_chars: ask_input_chars(&context, &history, &question),
    };
    run(&app, &ai, request_id, page_id, today, prompt, on_event).await
}

#[tauri::command]
pub async fn ai_cancel(ai: Ai<'_>, request_id: String) -> AppResult<()> {
    ai.cancel(&request_id);
    Ok(())
}

/// 패널 상태를 한 번에 준다. 자격 증명 관리자는 읽지 않는다.
#[tauri::command]
pub async fn get_ai_status(app: A<'_>, page_id: Option<i64>, today: String) -> AppResult<AiStatus> {
    check_day(&today)?;
    let conn = app.conn()?;
    let (excluded, exclude_mode) = match page_id {
        Some(id) => (db::ai::exclusion(&conn, id)?, db::ai::exclude_mode(&conn, id)?),
        None => (db::ai::Excluded::None, db::ai::ExcludeMode::None),
    };
    Ok(AiStatus {
        has_key: db::ai::key_last4(&conn)?.is_some(),
        excluded,
        exclude_mode,
        today_calls: db::ai::calls_on(&conn, &today)?,
        daily_limit: db::ai::daily_limit(&conn)?,
    })
}

#[tauri::command]
pub async fn set_ai_exclude(app: A<'_>, page_id: i64, mode: String) -> AppResult<()> {
    let mode = match mode.as_str() {
        "none" => 0,
        "self" => 1,
        "subtree" => 2,
        _ => return Err(invalid("mode는 none·self·subtree 중 하나여야 합니다")),
    };
    db::ai::set_exclude(&*app.conn()?, page_id, mode)
}

#[tauri::command]
pub async fn set_ai_daily_limit(app: A<'_>, limit: i64) -> AppResult<()> {
    db::ai::set_daily_limit(&*app.conn()?, limit)
}

#[tauri::command]
pub async fn list_ai_usage(app: A<'_>, days: Option<u32>) -> AppResult<Vec<db::ai::AiUsageDay>> {
    db::ai::list_usage(&*app.conn()?, days.unwrap_or(30))
}

/// 앞뒤 공백을 자르고, 시험 호출(크레딧 안 씀)을 통과해야만 저장한다(계약-AI 1.4, 10절 6).
#[tauri::command]
pub async fn set_api_key(app: A<'_>, ai: Ai<'_>, key: String) -> AppResult<Last4> {
    let key = key.trim();
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return Err(invalid("API 키가 비었거나 공백이 섞여 있습니다"));
    }
    client::check_key(&ai.client()?, key).await?;
    secret::save(key)?;
    let last4 = last4(key);
    // 화면 표시(last4)와 실제 키가 어긋나지 않게, DB에 못 쓰면 저장한 키도 지운다.
    if let Err(e) = app.conn().and_then(|c| db::ai::set_key_last4(&c, Some(&last4))) {
        let _ = secret::delete();
        return Err(e);
    }
    Ok(Last4 { last4 })
}

/// 자격 증명 관리자는 읽지 않는다(NF-05).
#[tauri::command]
pub async fn has_api_key(app: A<'_>) -> AppResult<KeyStatus> {
    let last4 = db::ai::key_last4(&*app.conn()?)?;
    Ok(KeyStatus { present: last4.is_some(), last4 })
}

/// 오프라인에서도 된다. 이미 없어도 성공.
#[tauri::command]
pub async fn delete_api_key(app: A<'_>) -> AppResult<()> {
    secret::delete()?;
    db::ai::set_key_last4(&*app.conn()?, None)
}

fn last4(key: &str) -> String {
    let n = key.chars().count();
    key.chars().skip(n.saturating_sub(4)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: Role, text: &str) -> AiTurn {
        AiTurn { role, text: text.into() }
    }

    #[test]
    fn body_per_task() {
        let b = request_body(Task::Summarize, vec![user("x".into())]);
        assert_eq!(b["model"], "claude-haiku-5-5");
        assert_eq!(b["max_tokens"], 1024);
        assert_eq!(b["thinking"]["type"], "disabled");
        assert_eq!(b["stream"], true);
        let b = request_body(Task::Rewrite, vec![]);
        assert_eq!((b["model"].as_str(), b["max_tokens"].as_u64()), (Some("claude-sonnet-5-5"), Some(16_000)));
        assert_eq!(b["thinking"]["type"], "between_tools");
        let b = request_body(Task::Ask, vec![]);
        assert_eq!((b["model"].as_str(), b["max_tokens"].as_u64()), (Some("claude-sonnet-5-5"), Some(4096)));
        // 이 API 버전에서 400이 나는 값은 보내지 않는다.
        for k in ["temperature", "top_p", "top_k", "effort"] {
            assert!(b.get(k).is_none(), "{k}");
        }
    }

    #[test]
    fn ask_messages_shape() {
        let m = ask_messages("본문", &[], "질문").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["content"], "<note>\n본문\n</note>\n\n질문");
        let h = [turn(Role::User, "q1"), turn(Role::Assistant, "a1")];
        let m = ask_messages("본문", &h, "q2").unwrap();
        let roles: Vec<_> = m.iter().map(|v| v["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
        assert!(m[0]["content"].as_str().unwrap().ends_with("q1"));
        assert_eq!(m[2]["content"], "q2");

        let bad: [&[AiTurn]; 3] = [
            &[turn(Role::User, "q1")],
            &[turn(Role::Assistant, "a"), turn(Role::User, "q")],
            &[turn(Role::User, " "), turn(Role::Assistant, "a")],
        ];
        for h in bad {
            assert_eq!(ask_messages("c", h, "q").unwrap_err().kind, ErrorKind::InvalidInput);
        }
        assert_eq!(ask_messages("c", &[], "  ").unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(ask_input_chars("가나", &h, "다"), 2 + 4 + 1);
    }

    #[test]
    fn single_prompt() {
        let p = single(Task::Rewrite, "가나다").unwrap();
        assert_eq!((p.task, p.input_chars, p.messages.len()), (Task::Rewrite, 3, 1));
        assert_eq!(p.messages[0]["content"], prompts::rewrite_user("가나다"));
        assert_eq!(single(Task::Summarize, " \n").err().unwrap().kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn day_format() {
        assert!(valid_day("2026-10-26"));
        for d in ["2026-1-26", "2026/10/26", "20261026", "2026-10-2a", "", "2026-10-26 "] {
            assert!(!valid_day(d), "{d}");
        }
    }

    #[test]
    fn slot_busy_and_cancel() {
        let ai = AiState::new();
        let slot = ai.reserve("a").unwrap();
        assert_eq!(ai.reserve("b").err().unwrap().kind, ErrorKind::AiBusy);
        assert!(!slot.cancelled());
        ai.cancel("other");
        assert!(!slot.cancelled());
        ai.cancel("a");
        assert!(slot.cancelled());
        drop(slot);
        assert!(ai.reserve("b").is_ok());
    }

    #[test]
    fn result_stop_reason() {
        let r = |reason: &str| {
            let v = serde_json::to_value(AiResult::new(client::Outcome { text: "t".into(), stop_reason: reason.into() }, 3));
            v.unwrap()
        };
        let v = r("max_tokens");
        assert_eq!((v["truncated"].as_bool(), v["stopReason"].as_str()), (Some(true), Some("max_tokens")));
        assert_eq!(v["inputChars"], 3);
        for reason in ["end_turn", "refusal", "unknown"] {
            let v = r(reason);
            assert_eq!((v["truncated"].as_bool(), v["stopReason"].as_str()), (Some(false), Some(reason)));
        }
    }

    #[test]
    fn last4_chars() {
        assert_eq!(last4("sk-ant-abcd1234"), "1234");
        assert_eq!(last4("ab"), "ab");
    }
}
