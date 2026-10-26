//! 스키마 마이그레이션(계약 5절). 배포한 항목은 고치지 않고 새 항목을 덧붙인다.
use crate::error::{AppError, AppResult, ErrorKind};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const MIGRATIONS: &[&str] = &[V1, V2];

const V1: &str = r#"
CREATE TABLE pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id     INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL,
  title         TEXT    NOT NULL DEFAULT '',
  content       TEXT    NOT NULL,
  expanded      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  trashed_at    INTEGER,
  trash_root_id INTEGER
);
CREATE INDEX pages_children ON pages(parent_id, position) WHERE trashed_at IS NULL;
CREATE INDEX pages_trash    ON pages(trash_root_id)      WHERE trash_root_id IS NOT NULL;

CREATE VIRTUAL TABLE page_fts USING fts5(title, body, tokenize='trigram');
CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  DELETE FROM page_fts WHERE rowid = old.id;
END;

CREATE TABLE attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  file_name  TEXT    NOT NULL UNIQUE,
  mime       TEXT    NOT NULL,
  byte_size  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
"#;

/// 계약-DB v2 4.1절(AI 전송 제외·사용 기록).
const V2: &str = r#"
ALTER TABLE pages ADD COLUMN ai_exclude INTEGER NOT NULL DEFAULT 0 CHECK (ai_exclude IN (0, 1, 2));

CREATE TABLE ai_usage (
  day         TEXT    PRIMARY KEY,
  calls       INTEGER NOT NULL DEFAULT 0,
  input_chars INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
"#;

fn mig_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Migration, format!("마이그레이션 실패: {e}"))
}

/// `db_path`가 있으면(파일 DB) 기존 DB에 적용하기 전에 `<db>.bak-v<버전>`으로 백업한다.
pub fn migrate(conn: &mut Connection, migrations: &[&str], db_path: Option<&Path>) -> AppResult<()> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(mig_err)?;
    let target = migrations.len() as i64;
    if version > target {
        return Err(AppError::new(
            ErrorKind::Migration,
            format!("DB 버전 {version}이 이 앱이 아는 버전 {target}보다 새롭습니다. 앱을 업데이트하세요"),
        ));
    }
    if version == target {
        return Ok(());
    }
    if version >= 1
        && let Some(path) = db_path
    {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".bak-v{version}"));
        let bak = PathBuf::from(&name);
        // 임시 이름으로 만든 뒤 바꿔 끼운다. 실패해도 이전 백업이 남는다.
        name.push(".tmp");
        let tmp = PathBuf::from(name);
        let _ = std::fs::remove_file(&tmp);
        let tmp_str = tmp.to_str().ok_or_else(|| mig_err("백업 경로가 UTF-8이 아닙니다"))?;
        conn.execute("VACUUM INTO ?1", [tmp_str]).map_err(mig_err)?;
        std::fs::rename(&tmp, &bak).map_err(mig_err)?;
    }
    for (i, sql) in migrations.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction().map_err(mig_err)?;
        tx.execute_batch(sql).map_err(mig_err)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64).map_err(mig_err)?;
        tx.commit().map_err(mig_err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap()
    }

    #[test]
    fn new_db_gets_latest_schema() {
        let conn = crate::db::open_memory();
        assert_eq!(version(&conn), 2);
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE name IN ('pages','page_fts','attachments','app_state','pages_ad','ai_usage','sqlite_sequence')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 7);
        let ai_exclude: i64 = conn
            .query_row("SELECT count(*) FROM pragma_table_info('pages') WHERE name = 'ai_exclude'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ai_exclude, 1);
        let bad = conn.execute(
            "INSERT INTO pages (position, content, created_at, updated_at, ai_exclude) VALUES (0, '{}', 0, 0, 3)",
            [],
        );
        assert!(bad.is_err(), "ai_exclude는 0·1·2만");
    }

    /// 카드 1-①: 마지막 행을 지워도 그 번호를 다시 쓰지 않는다.
    #[test]
    fn ids_are_not_reused_after_delete() {
        let conn = crate::db::open_memory();
        for (table, insert) in [
            ("pages", "INSERT INTO pages (position, content, created_at, updated_at) VALUES (0, '{}', 0, 0)"),
            (
                "attachments",
                "INSERT INTO attachments (file_name, mime, byte_size, created_at) VALUES (random(), 'image/png', 1, 0)",
            ),
        ] {
            conn.execute(insert, []).unwrap();
            let first = conn.last_insert_rowid();
            conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [first]).unwrap();
            conn.execute(insert, []).unwrap();
            assert!(conn.last_insert_rowid() > first, "{table}");
        }
    }

    #[test]
    fn newer_db_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        let err = migrate(&mut conn, MIGRATIONS, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Migration);
    }

    #[test]
    fn file_db_backup_then_upgrade_and_rollback_on_failure() {
        let dir = crate::db::temp_dir("mig");
        let path = dir.join("wy-note.db");

        // v1 생성 + 데이터 하나
        let conn = crate::db::open(&path).unwrap();
        conn.execute("INSERT INTO app_state(key, value) VALUES ('k', '1')", []).unwrap();
        drop(conn);

        // v2 적용: 백업이 생기고 버전이 올라간다
        let mut conn = Connection::open(&path).unwrap();
        let v2 = [V1, V2, "CREATE TABLE extra (a INTEGER);"];
        migrate(&mut conn, &v2, Some(&path)).unwrap();
        assert_eq!(version(&conn), 3);
        let bak = dir.join("wy-note.db.bak-v2");
        assert!(bak.exists());
        let bconn = Connection::open(&bak).unwrap();
        assert_eq!(version(&bconn), 2);
        let v: String = bconn.query_row("SELECT value FROM app_state WHERE key='k'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "1");
        drop(bconn);

        // 실패하는 v3: 롤백되어 버전·스키마가 그대로
        let v3 = [V1, V2, "CREATE TABLE extra (a INTEGER);", "CREATE TABLE ok3 (a); THIS IS NOT SQL;"];
        let err = migrate(&mut conn, &v3, Some(&path)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Migration);
        assert_eq!(version(&conn), 3);
        let ok3: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master WHERE name='ok3'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok3, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
