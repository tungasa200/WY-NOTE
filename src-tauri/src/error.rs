use serde::Serialize;
use std::fmt;

/// 화면(`invoke` reject)으로 가는 오류 종류. 계약 8절 `AppError.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    NotFound,
    InvalidMove,
    InvalidInput,
    Db,
    Io,
    Migration,
    /// 첨부가 20MB 초과(계약 v2)
    FileTooLarge,
    /// 허용 밖 이미지 형식(계약 v2)
    UnsupportedType,
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
        Self::new(ErrorKind::Db, e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, e.to_string())
    }
}
