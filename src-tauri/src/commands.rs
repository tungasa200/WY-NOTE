//! Tauri 명령 19개(계약 8절)와 wyasset 프로토콜 응답. 화면↔백엔드 경계.
use crate::db::{
    attachments,
    pages::{self, Page, ToRoot, TrashItem, TrashedCount, TreeNode, UpdatedAt},
    search::{self, SearchHit},
};
use crate::error::{AppError, AppResult, ErrorKind};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};
use tauri::http::{Response, StatusCode, header};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

/// 쓰기 연결과 읽기 전용 연결(계약 3절). WAL이라 다른 프로세스가 쓰기 잠금을 잡고 있어도
/// 읽기 연결은 막히지 않는다. 읽기가 쓰기 명령의 잠금 대기 뒤에 줄 서지 않게 나눴다(P4-6).
/// 필드 순서대로 닫힌다. 쓰기 연결이 마지막에 닫혀야 WAL 파일을 지울 수 있다(읽기 전용 연결은 못 지움).
struct Db {
    read: Mutex<Connection>,
    write: Mutex<Connection>,
}

pub struct AppState {
    /// 시작 때 DB 열기·마이그레이션에 실패하면 그 오류를 들고 있다가 모든 명령에서 돌려준다(화면이 띄움).
    db: Result<Db, AppError>,
    data_dir: PathBuf,
}

/// 연결을 잡고, DB 잠금 대기 시간을 '명령이 들어온 때부터 5초'로 맞춘다(계약 3절, P4-6).
/// Mutex에서 기다린 만큼 busy_timeout을 줄이고, 다 썼으면 0(기다리지 않고 바로 시도).
fn lock(m: &Mutex<Connection>) -> AppResult<MutexGuard<'_, Connection>> {
    let start = Instant::now();
    // 다른 명령이 패닉해도 트랜잭션은 drop 때 롤백되므로 연결은 계속 쓸 수 있다.
    let conn = m.lock().unwrap_or_else(|e| e.into_inner());
    conn.busy_timeout(crate::db::BUSY_TIMEOUT.saturating_sub(start.elapsed()))?;
    Ok(conn)
}

impl AppState {
    /// `db`는 (쓰기 연결, 읽기 전용 연결).
    pub fn new(db: AppResult<(Connection, Connection)>, data_dir: PathBuf) -> Self {
        let db = db.map(|(w, r)| Db { read: Mutex::new(r), write: Mutex::new(w) });
        Self { db, data_dir }
    }

    fn db(&self) -> AppResult<&Db> {
        self.db.as_ref().map_err(Clone::clone)
    }

    /// 쓰기 연결. 쓰기 명령과 읽고 쓰는 명령이 쓴다.
    pub(crate) fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        lock(&self.db()?.write)
    }

    /// 읽기 전용 연결. 읽기만 하는 명령이 쓴다.
    pub(crate) fn read_conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        lock(&self.db()?.read)
    }

    /// 종료 때 WAL을 본 파일에 합친다(계약 v2 11절 ⑤). 실패해도 데이터는 안전하다(다음 실행 때 합쳐짐).
    /// 종료를 기다리게 하지 않는다: 다른 명령이 연결을 쓰는 중(DB 잠금 대기 등)이면 건너뛰고,
    /// 다른 프로세스가 DB를 잡고 있으면 busy_timeout만큼 기다리지 않고 바로 포기한다(P4-3 조사 3).
    pub fn checkpoint(&self) {
        let Ok(db) = &self.db else { return };
        fn try_lock(m: &Mutex<Connection>) -> Option<MutexGuard<'_, Connection>> {
            match m.try_lock() {
                Ok(c) => Some(c),
                Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
                Err(TryLockError::WouldBlock) => None,
            }
        }
        // 읽기 연결도 잡아 둔다. 읽는 중이면 TRUNCATE를 끝내지 못하므로 그때도 건너뛴다.
        let (Some(_read), Some(conn)) = (try_lock(&db.read), try_lock(&db.write)) else { return };
        let _ = conn.busy_timeout(Duration::ZERO);
        // 결과 행(busy, log, checkpointed)을 돌려주는 PRAGMA라 query_row로 부른다.
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        let _ = conn.busy_timeout(crate::db::BUSY_TIMEOUT);
    }

    pub(crate) fn attachments_dir(&self) -> PathBuf {
        self.data_dir.join("attachments")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedCount {
    deleted_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileName {
    file_name: String,
}

type S<'a> = State<'a, AppState>;

#[tauri::command]
pub async fn list_tree(state: S<'_>) -> AppResult<Vec<TreeNode>> {
    pages::list_tree(&*state.read_conn()?)
}

#[tauri::command]
pub async fn get_page(state: S<'_>, id: i64) -> AppResult<Page> {
    pages::get_page(&*state.read_conn()?, id)
}

#[tauri::command]
pub async fn create_page(state: S<'_>, parent_id: Option<i64>) -> AppResult<Page> {
    pages::create_page(&mut *state.conn()?, parent_id)
}

#[tauri::command]
pub async fn rename_page(state: S<'_>, id: i64, title: String) -> AppResult<UpdatedAt> {
    pages::rename_page(&mut *state.conn()?, id, &title)
}

#[tauri::command]
pub async fn save_page(state: S<'_>, id: i64, content: Value) -> AppResult<UpdatedAt> {
    pages::save_page(&mut *state.conn()?, id, &content)
}

#[tauri::command]
pub async fn move_page(state: S<'_>, id: i64, new_parent_id: Option<i64>, new_position: i64) -> AppResult<()> {
    pages::move_page(&mut *state.conn()?, id, new_parent_id, new_position)
}

#[tauri::command]
pub async fn set_expanded(state: S<'_>, id: i64, expanded: bool) -> AppResult<()> {
    pages::set_expanded(&*state.conn()?, id, expanded)
}

#[tauri::command]
pub async fn trash_page(state: S<'_>, id: i64) -> AppResult<TrashedCount> {
    pages::trash_page(&mut *state.conn()?, id)
}

#[tauri::command]
pub async fn list_trash(state: S<'_>) -> AppResult<Vec<TrashItem>> {
    pages::list_trash(&*state.read_conn()?)
}

#[tauri::command]
pub async fn restore_page(state: S<'_>, id: i64) -> AppResult<ToRoot> {
    pages::restore_page(&mut *state.conn()?, id)
}

#[tauri::command]
pub async fn delete_page_permanently(state: S<'_>, id: i64) -> AppResult<()> {
    let files = pages::delete_page_permanently(&mut *state.conn()?, id)?;
    attachments::remove_files(&state.attachments_dir(), &files);
    Ok(())
}

#[tauri::command]
pub async fn empty_trash(state: S<'_>) -> AppResult<DeletedCount> {
    let (deleted_count, files) = pages::empty_trash(&mut *state.conn()?)?;
    attachments::remove_files(&state.attachments_dir(), &files);
    Ok(DeletedCount { deleted_count })
}

#[tauri::command]
pub async fn search(state: S<'_>, query: String, limit: Option<u32>) -> AppResult<Vec<SearchHit>> {
    search::search(&*state.read_conn()?, &query, limit)
}

#[tauri::command]
pub async fn get_start_page_id(state: S<'_>) -> AppResult<Option<i64>> {
    pages::get_start_page_id(&*state.read_conn()?)
}

#[tauri::command]
pub async fn set_last_page(state: S<'_>, id: i64) -> AppResult<()> {
    pages::set_last_page(&*state.conn()?, id)
}

/// `invoke('save_attachment', bytes, { headers: { 'x-page-id', 'x-ext' } })`
#[tauri::command]
pub async fn save_attachment(state: S<'_>, request: Request<'_>) -> AppResult<FileName> {
    let invalid = |m: &str| AppError::new(ErrorKind::InvalidInput, m);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid("본문은 원본 바이트여야 합니다"));
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let page_id = header("x-page-id")
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| invalid("x-page-id 헤더가 없거나 숫자가 아닙니다"))?;
    let ext = header("x-ext").ok_or_else(|| invalid("x-ext 헤더가 없습니다"))?;
    let file_name = attachments::save_attachment(&mut *state.conn()?, &state.attachments_dir(), page_id, ext, bytes)?;
    Ok(FileName { file_name })
}

#[tauri::command]
pub async fn get_ui_state(state: S<'_>) -> AppResult<Value> {
    pages::get_ui_state(&*state.read_conn()?)
}

#[tauri::command]
pub async fn set_ui_state(app_state: S<'_>, state: Value) -> AppResult<()> {
    // JS 인자 이름이 state(계약)라 State 매개변수 이름을 바꿨다.
    pages::set_ui_state(&*app_state.conn()?, &state)
}

#[tauri::command]
pub async fn get_data_dir(state: S<'_>) -> AppResult<String> {
    Ok(state.data_dir.to_string_lossy().into_owned())
}

/// `http://wyasset.localhost/<파일 이름>` 응답. attachments 폴더 안 파일만 내준다.
pub fn asset_response(app: &AppHandle, uri_path: &str) -> Response<Cow<'static, [u8]>> {
    let found = app.try_state::<AppState>().and_then(|s| {
        let path = attachments::resolve_asset(&s.attachments_dir(), uri_path)?;
        let mime = attachments::mime_for(path.extension()?.to_str()?)?;
        Some((std::fs::read(&path).ok()?, mime))
    });
    let res = match found {
        Some((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header("X-Content-Type-Options", "nosniff")
            // 주소로 직접 열어도 스크립트가 돌지 않게 한다(SVG는 받지 않지만 방어용으로 둔다).
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            .body(Cow::Owned(bytes)),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&[][..])),
    };
    res.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_truncates_wal() {
        let dir = crate::db::temp_dir("ckpt");
        let state = AppState::new(crate::db::open_pair(&dir.join("wy-note.db")), dir.clone());
        state.conn().unwrap().execute("INSERT INTO app_state (key, value) VALUES ('k', '1')", []).unwrap();
        let wal = dir.join("wy-note.db-wal");
        assert!(std::fs::metadata(&wal).unwrap().len() > 0);
        state.checkpoint();
        assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 다른 연결이 쓰기 잠금을 잡고 있거나 명령이 연결을 쓰는 중이어도 종료가 기다리지 않는다(P4-3 조사 3).
    #[test]
    fn checkpoint_does_not_wait_on_locks() {
        let dir = crate::db::temp_dir("ckpt-lock");
        let path = dir.join("wy-note.db");
        let state = AppState::new(crate::db::open_pair(&path), dir.clone());
        state.conn().unwrap().execute("INSERT INTO app_state (key, value) VALUES ('k', '1')", []).unwrap();
        let other = Connection::open(&path).unwrap();
        other.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let t = Instant::now();
        state.checkpoint();
        let held = state.conn().unwrap();
        state.checkpoint();
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        drop(held);
        drop(other);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 쓰기 연결·읽기 연결이 있는 AppState와, DB를 BEGIN EXCLUSIVE로 잡은 다른 연결(다른 프로세스 역할).
    fn locked_state(tag: &str) -> (AppState, Connection, PathBuf, i64) {
        let dir = crate::db::temp_dir(tag);
        let path = dir.join("wy-note.db");
        let state = AppState::new(crate::db::open_pair(&path), dir.clone());
        let id = pages::create_page(&mut state.conn().unwrap(), None).unwrap().id;
        let other = Connection::open(&path).unwrap();
        other.execute_batch("BEGIN EXCLUSIVE; UPDATE pages SET title = 'x'").unwrap();
        (state, other, dir, id)
    }

    /// 쓰기 명령이 잠금을 기다리며 쓰기 연결을 잡고 있어도 읽기 명령은 바로 된다(P4-6 A).
    #[test]
    fn reads_do_not_queue_behind_locked_write() {
        let (state, other, dir, id) = locked_state("read-while-locked");
        let held = state.conn().unwrap();
        let t = Instant::now();
        assert_eq!(pages::get_page(&*state.read_conn().unwrap(), id).unwrap().id, id);
        assert_eq!(pages::list_tree(&*state.read_conn().unwrap()).unwrap().len(), 1);
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        drop(held);
        drop((other, state));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 잠금 대기 5초는 명령이 들어온 때부터 잰다(P4-6 B). 실패는 DbBusy(P4-6 C).
    /// 앞 명령이 쓰기 연결을 3초 잡아도 뒤 명령은 3+5초가 아니라 약 5초 만에 실패한다.
    #[test]
    fn write_wait_counts_from_command_start_and_fails_as_db_busy() {
        let (state, other, dir, _) = locked_state("wait-from-start");
        std::thread::scope(|s| {
            let (locked, wait_locked) = std::sync::mpsc::channel();
            let st = &state;
            s.spawn(move || {
                let _first = st.conn().unwrap();
                locked.send(()).unwrap();
                std::thread::sleep(Duration::from_secs(3));
            });
            wait_locked.recv().unwrap();
            let t = Instant::now();
            let err = state.conn().and_then(|c| pages::set_ui_state(&c, &serde_json::json!({}))).unwrap_err();
            let waited = t.elapsed();
            assert_eq!(err.kind, ErrorKind::DbBusy, "{err}");
            assert!(waited >= Duration::from_millis(2900), "{waited:?}");
            assert!(waited < Duration::from_secs(7), "{waited:?}");
        });
        drop((other, state));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 잠금 말고 다른 SQLite 오류는 지금처럼 Db다.
    #[test]
    fn other_sqlite_errors_stay_db() {
        let conn = crate::db::open_memory();
        let e: AppError = conn.execute("INSERT INTO no_such_table VALUES (1)", []).unwrap_err().into();
        assert_eq!(e.kind, ErrorKind::Db);
    }
}
