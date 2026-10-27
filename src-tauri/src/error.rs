use serde::Serialize;
use std::fmt;

/// 화면(`invoke` reject)으로 가는 오류 종류. 계약 8절 `AppError.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    NotFound,
    InvalidMove,
    InvalidInput,
    Db,
    /// 다른 프로그램이 DB를 잡고 있어 5초 안에 쓰지 못함(SQLITE_BUSY, P4-6)
    DbBusy,
    Io,
    Migration,
    /// 첨부가 20MB 초과(계약 v2)
    FileTooLarge,
    /// 허용 밖 이미지 형식(계약 v2)
    UnsupportedType,
    // 계약-AI 4.1
    NoApiKey,
    Keyring,
    Offline,
    AiTimeout,
    AiAuth,
    AiCredit,
    AiRateLimit,
    AiOverloaded,
    AiApi,
    AiExcluded,
    AiDailyLimit,
    InputTooLong,
    AiBusy,
    Cancelled,
}

/// `{ kind, message }`로 직렬화된다. message에는 노트 본문을 넣지 않는다.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        // SQLITE_LOCKED는 같은 연결 안의 충돌(코드 결함)이라 다른 프로그램 탓인 DbBusy로 보지 않는다.
        let kind = match e.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy) => ErrorKind::DbBusy,
            _ => ErrorKind::Db,
        };
        Self::new(kind, e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, e.to_string())
    }
}
