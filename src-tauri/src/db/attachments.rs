//! 첨부 이미지(F-02.6, 계약 4·8절). 파일은 attachments 폴더, 본문에는 파일 이름만.
use super::{now_ms, pages::ensure_alive};
use crate::error::{AppError, AppResult, ErrorKind};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::path::{Path, PathBuf};

const TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
];

pub fn mime_for(ext: &str) -> Option<&'static str> {
    TYPES.iter().find(|(e, _)| e.eq_ignore_ascii_case(ext)).map(|(_, m)| *m)
}

/// 행을 넣어 id를 받고 `<id>.<ext>`로 파일을 쓴 뒤 커밋한다. 파일 쓰기에 실패하면 롤백.
pub fn save_attachment(conn: &mut Connection, dir: &Path, page_id: i64, ext: &str, bytes: &[u8]) -> AppResult<String> {
    let ext = ext.to_ascii_lowercase();
    let mime = mime_for(&ext)
        .ok_or_else(|| AppError::new(ErrorKind::InvalidInput, format!("지원하지 않는 이미지 형식: {ext}")))?;
    if bytes.is_empty() {
        return Err(AppError::new(ErrorKind::InvalidInput, "빈 파일입니다"));
    }
    let tx = conn.transaction()?;
    ensure_alive(&tx, page_id)?;
    tx.execute(
        "INSERT INTO attachments (page_id, file_name, mime, byte_size, created_at) VALUES (?1, '', ?2, ?3, ?4)",
        params![page_id, mime, bytes.len() as i64, now_ms()],
    )?;
    let id = tx.last_insert_rowid();
    let name = format!("{id}.{ext}");
    tx.execute("UPDATE attachments SET file_name = ?1 WHERE id = ?2", params![name, id])?;
    fs::create_dir_all(dir)?;
    let path = dir.join(&name);
    fs::write(&path, bytes)?;
    if let Err(e) = tx.commit() {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(name)
}

/// 영구 삭제로 `page_id`가 NULL이 된 첨부를 정리한다. 아직 본문에서 쓰는 페이지가 있으면 그 페이지로 옮기고,
/// 없으면 행을 지우고 그 파일 이름을 돌려준다(파일은 커밋 뒤 지운다).
pub fn orphan_cleanup(conn: &Connection) -> AppResult<Vec<String>> {
    let orphans: Vec<(i64, String)> = conn
        .prepare("SELECT id, file_name FROM attachments WHERE page_id IS NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut removed = Vec::new();
    for (id, name) in orphans {
        let user: Option<i64> = conn
            // 본문 JSON의 "src":"12.png" — 따옴표까지 맞춰 2.png가 12.png에 걸리지 않게 한다.
            .query_row("SELECT id FROM pages WHERE instr(content, ?1) > 0 LIMIT 1", [format!("\"{name}\"")], |r| {
                r.get(0)
            })
            .optional()?;
        match user {
            Some(page) => {
                conn.execute("UPDATE attachments SET page_id = ?1 WHERE id = ?2", params![page, id])?;
            }
            None => {
                conn.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
                removed.push(name);
            }
        }
    }
    Ok(removed)
}

/// 실패해도 고아 파일만 남으므로 오류는 무시한다.
pub fn remove_files(dir: &Path, names: &[String]) {
    for n in names {
        if let Some(p) = resolve_asset(dir, &format!("/{n}")) {
            let _ = fs::remove_file(p);
        }
    }
}

/// wyasset 요청 경로(`/12.png`)를 attachments 폴더 안의 실제 파일로 바꾼다. 폴더 밖이거나 없으면 None.
pub fn resolve_asset(dir: &Path, uri_path: &str) -> Option<PathBuf> {
    let name = uri_path.strip_prefix('/')?;
    let plain = !name.is_empty()
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !plain {
        return None;
    }
    let base = dir.canonicalize().ok()?;
    let full = base.join(name).canonicalize().ok()?;
    (full.parent() == Some(base.as_path()) && full.is_file()).then_some(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_memory, pages, temp_dir};
    use serde_json::json;

    #[test]
    fn resolve_asset_rejects_paths_outside_folder() {
        let root = temp_dir("asset");
        let dir = root.join("attachments");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("12.png"), b"x").unwrap();
        fs::write(dir.join("sub").join("1.png"), b"x").unwrap();
        fs::write(root.join("wy-note.db"), b"secret").unwrap();

        assert_eq!(resolve_asset(&dir, "/12.png"), Some(dir.join("12.png").canonicalize().unwrap()));
        let bad = [
            "/../wy-note.db",
            "/..\\wy-note.db",
            "/..%2Fwy-note.db",
            "/%2e%2e/wy-note.db",
            "/sub/1.png",
            "/sub\\1.png",
            "//12.png",
            "/C:/Windows/win.ini",
            "/C:\\Windows\\win.ini",
            "/\\\\server\\share\\x.png",
            &format!("/{}", root.join("wy-note.db").display()),
            "/..",
            "/.",
            "/",
            "",
            "12.png",
            "/NUL",
            "/CON",
            "/sub",
            "/99.png", // 없는 파일
        ];
        for p in bad {
            assert_eq!(resolve_asset(&dir, p), None, "{p}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_and_cleanup_on_permanent_delete() {
        let root = temp_dir("att");
        let dir = root.join("attachments");
        let mut c = open_memory();
        let a = pages::create_page(&mut c, None).unwrap().id;
        let b = pages::create_page(&mut c, None).unwrap().id;

        let n1 = save_attachment(&mut c, &dir, a, "PNG", b"img1").unwrap();
        let n2 = save_attachment(&mut c, &dir, a, "jpg", b"img2").unwrap();
        assert!(n1.ends_with(".png") && n2.ends_with(".jpg"));
        assert_eq!(fs::read(dir.join(&n1)).unwrap(), b"img1");
        assert_eq!(save_attachment(&mut c, &dir, a, "exe", b"x").unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(save_attachment(&mut c, &dir, a, "png", b"").unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(save_attachment(&mut c, &dir, 999, "png", b"x").unwrap_err().kind, ErrorKind::NotFound);

        // n2는 b 본문에도 붙여 넣었다
        // b는 n2와, n1을 끝에 품은 다른 이름("9" + n1)을 쓴다. n1은 부분 문자열로 걸리면 안 된다.
        let doc = json!({"type":"doc","content":[
            {"type":"image","attrs":{"src": n2}},
            {"type":"image","attrs":{"src": format!("9{n1}")}}
        ]});
        pages::save_page(&mut c, b, &doc).unwrap();

        pages::trash_page(&mut c, a).unwrap();
        assert!(dir.join(&n1).exists()); // 영구 삭제 전에는 남는다
        let removed = pages::delete_page_permanently(&mut c, a).unwrap();
        assert_eq!(removed, vec![n1.clone()]);
        remove_files(&dir, &removed);
        assert!(!dir.join(&n1).exists());
        assert!(dir.join(&n2).exists());
        let owner: i64 = c.query_row("SELECT page_id FROM attachments WHERE file_name = ?1", [&n2], |r| r.get(0)).unwrap();
        assert_eq!(owner, b);
        let _ = fs::remove_dir_all(&root);
    }
}
