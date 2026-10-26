//! API 키 접근 유일 모듈(NF-05, 계약-AI 1.3). `keyring_core`를 쓰는 파일은 이것 하나다.
//! 키는 Windows 자격 증명 관리자의 일반 자격 증명 `wy-note/claude-api-key`(Local Machine 지속성)에만 둔다.
use crate::error::{AppError, AppResult, ErrorKind};
use keyring_core::{Entry, Error};
use std::collections::HashMap;

/// setup에서 한 번 부른다.
pub fn init() -> AppResult<()> {
    let store = windows_native_keyring_store::Store::new().map_err(err)?;
    keyring_core::set_default_store(store);
    Ok(())
}

/// 있으면 덮어쓴다.
pub fn save(key: &str) -> AppResult<()> {
    entry()?.set_password(key).map_err(err)
}

/// 없으면 `None`. AI 호출 직전에만 부른다(NF-05 "키는 API 호출 때만 읽음").
pub fn load() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// 이미 없어도 성공.
pub fn delete() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

fn entry() -> AppResult<Entry> {
    // 기본 이름 규칙은 "<user>.<service>"라 서비스의 '.'과 섞인다. target으로 이름을 고정한다.
    let mods = HashMap::from([("target", "wy-note/claude-api-key"), ("persistence", "Local")]);
    Entry::new_with_modifiers("com.wynote.desktop", "claude-api-key", &mods).map_err(err)
}

/// 키 바이트가 담길 수 있는 변형(BadEncoding 등)은 내용을 찍지 않는다.
fn err(e: Error) -> AppError {
    let detail = match &e {
        Error::PlatformFailure(p) | Error::NoStorageAccess(p) => p.to_string(),
        Error::NoDefaultStore => "자격 증명 저장소가 준비되지 않았습니다".into(),
        Error::BadEncoding(_) | Error::BadDataFormat(..) => "저장된 값의 형식이 잘못되었습니다".into(),
        _ => "알 수 없는 오류".into(),
    };
    AppError::new(ErrorKind::Keyring, format!("자격 증명 관리자 오류: {detail}"))
}
