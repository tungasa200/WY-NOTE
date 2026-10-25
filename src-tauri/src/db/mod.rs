//! SQLite 계층. SQL·트랜잭션·평문 추출은 모두 이 모듈 안에 있다(계약-DB.md 0절).
pub mod attachments;
pub mod migrations;
pub mod pages;
pub mod search;

use crate::error::AppResult;
use rusqlite::Connection;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// DB 파일을 열고 PRAGMA를 설정한 뒤 마이그레이션을 적용한다(계약 3·5절).
pub fn open(path: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrations::migrate(&mut conn, migrations::MIGRATIONS, Some(path))?;
    Ok(conn)
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    Ok(())
}

/// Unix 밀리초.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
pub fn open_memory() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    configure(&conn).unwrap();
    migrations::migrate(&mut conn, migrations::MIGRATIONS, None).unwrap();
    conn
}

/// 테스트용 빈 임시 폴더.
#[cfg(test)]
pub fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wy-note-test-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
