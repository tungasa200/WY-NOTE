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
use std::sync::{Mutex, MutexGuard};
use tauri::http::{Response, StatusCode, header};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    /// 시작 때 DB 열기·마이그레이션에 실패하면 그 오류를 들고 있다가 모든 명령에서 돌려준다(화면이 띄움).
    db: Result<Mutex<Connection>, AppError>,
    data_dir: PathBuf,
}

impl AppState {
    pub fn new(db: AppResult<Connection>, data_dir: PathBuf) -> Self {
        Self { db: db.map(Mutex::new), data_dir }
    }

    fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        match &self.db {
            // 다른 명령이 패닉해도 트랜잭션은 drop 때 롤백되므로 연결은 계속 쓸 수 있다.
            Ok(m) => Ok(m.lock().unwrap_or_else(|e| e.into_inner())),
            Err(e) => Err(e.clone()),
        }
    }

    /// 종료 때 WAL을 본 파일에 합친다(계약 v2 11절 ⑤). 실패해도 데이터는 안전하다(다음 실행 때 합쳐짐).
    pub fn checkpoint(&self) {
        if let Ok(conn) = self.conn() {
            // 결과 행(busy, log, checkpointed)을 돌려주는 PRAGMA라 query_row로 부른다.
            let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
    }

    fn attachments_dir(&self) -> PathBuf {
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
    pages::list_tree(&*state.conn()?)
}

#[tauri::command]
pub async fn get_page(state: S<'_>, id: i64) -> AppResult<Page> {
    pages::get_page(&*state.conn()?, id)
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
    pages::list_trash(&*state.conn()?)
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
    search::search(&*state.conn()?, &query, limit)
}

#[tauri::command]
pub async fn get_start_page_id(state: S<'_>) -> AppResult<Option<i64>> {
    pages::get_start_page_id(&*state.conn()?)
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
    pages::get_ui_state(&*state.conn()?)
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
        let conn = crate::db::open(&dir.join("wy-note.db")).unwrap();
        conn.execute("INSERT INTO app_state (key, value) VALUES ('k', '1')", []).unwrap();
        let wal = dir.join("wy-note.db-wal");
        assert!(std::fs::metadata(&wal).unwrap().len() > 0);
        let state = AppState::new(Ok(conn), dir.clone());
        state.checkpoint();
        assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
