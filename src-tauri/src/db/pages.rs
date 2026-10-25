//! 페이지 트리·본문·휴지통·앱 상태(계약 4·8절).
use super::{attachments, now_ms, search::extract_text};
use crate::error::{AppError, AppResult, ErrorKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

const EMPTY_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub position: i64,
    pub title: String,
    pub expanded: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
    pub content: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: i64,
    pub title: String,
    pub trashed_at: i64,
    pub descendant_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedAt {
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedCount {
    pub trashed_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToRoot {
    pub to_root: bool,
}

fn not_found(id: i64) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("페이지 {id}이(가) 없거나 휴지통에 있습니다"))
}

fn is_alive(conn: &Connection, id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1 AND trashed_at IS NULL)",
        [id],
        |r| r.get(0),
    )?)
}

pub(super) fn ensure_alive(conn: &Connection, id: i64) -> AppResult<()> {
    if is_alive(conn, id)? { Ok(()) } else { Err(not_found(id)) }
}

fn parent_of(conn: &Connection, id: i64) -> AppResult<Option<i64>> {
    Ok(conn.query_row("SELECT parent_id FROM pages WHERE id = ?1", [id], |r| r.get(0))?)
}

/// 살아 있는 자식 id를 순서대로. `except`는 목록에서 뺀다.
fn children(conn: &Connection, parent: Option<i64>, except: Option<i64>) -> AppResult<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT id FROM pages WHERE parent_id IS ?1 AND trashed_at IS NULL AND id IS NOT ?2 ORDER BY position, id",
    )?;
    let ids = st.query_map(params![parent, except], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids)
}

fn write_order(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let mut st = conn.prepare("UPDATE pages SET position = ?1 WHERE id = ?2 AND position IS NOT ?1")?;
    for (i, id) in ids.iter().enumerate() {
        st.execute(params![i as i64, id])?;
    }
    Ok(())
}

/// `id`를 `parent` 아래 `pos`(형제 수로 잘라 냄)에 끼우고 형제 번호를 0..n-1로 다시 매긴다.
fn insert_at(conn: &Connection, parent: Option<i64>, id: i64, pos: i64) -> AppResult<()> {
    let mut ids = children(conn, parent, Some(id))?;
    let at = pos.clamp(0, ids.len() as i64) as usize;
    ids.insert(at, id);
    conn.execute("UPDATE pages SET parent_id = ?1 WHERE id = ?2", params![parent, id])?;
    write_order(conn, &ids)
}

fn renumber(conn: &Connection, parent: Option<i64>) -> AppResult<()> {
    write_order(conn, &children(conn, parent, None)?)
}

pub fn list_tree(conn: &Connection) -> AppResult<Vec<TreeNode>> {
    let mut st = conn.prepare(
        "SELECT id, parent_id, position, title, expanded FROM pages
         WHERE trashed_at IS NULL ORDER BY parent_id, position",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(TreeNode {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                position: r.get(2)?,
                title: r.get(3)?,
                expanded: r.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// 휴지통 페이지도 읽을 수 있다.
pub fn get_page(conn: &Connection, id: i64) -> AppResult<Page> {
    let row = conn
        .query_row(
            "SELECT parent_id, title, content, created_at, updated_at FROM pages WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found(id))?;
    Ok(Page {
        id,
        parent_id: row.0,
        title: row.1,
        content: serde_json::from_str(&row.2)
            .map_err(|e| AppError::new(ErrorKind::Db, format!("본문 JSON 해석 실패: {e}")))?,
        created_at: row.3,
        updated_at: row.4,
    })
}

pub fn create_page(conn: &mut Connection, parent_id: Option<i64>) -> AppResult<Page> {
    let tx = conn.transaction()?;
    if let Some(p) = parent_id {
        ensure_alive(&tx, p)?;
    }
    let pos: i64 = tx.query_row(
        "SELECT count(*) FROM pages WHERE parent_id IS ?1 AND trashed_at IS NULL",
        [parent_id],
        |r| r.get(0),
    )?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO pages (parent_id, position, title, content, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, ?4, ?4)",
        params![parent_id, pos, EMPTY_DOC, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute("INSERT INTO page_fts (rowid, title, body) VALUES (?1, '', '')", [id])?;
    if let Some(p) = parent_id {
        tx.execute("UPDATE pages SET expanded = 1 WHERE id = ?1", [p])?;
    }
    let page = get_page(&tx, id)?;
    tx.commit()?;
    Ok(page)
}

pub fn rename_page(conn: &mut Connection, id: i64, title: &str) -> AppResult<UpdatedAt> {
    let title = title.trim();
    let tx = conn.transaction()?;
    let now = now_ms();
    let n = tx.execute(
        "UPDATE pages SET title = ?1, updated_at = ?2 WHERE id = ?3 AND trashed_at IS NULL",
        params![title, now, id],
    )?;
    if n == 0 {
        return Err(not_found(id));
    }
    tx.execute("UPDATE page_fts SET title = ?1 WHERE rowid = ?2", params![title, id])?;
    tx.commit()?;
    Ok(UpdatedAt { updated_at: now })
}

/// 본문과 검색 색인을 한 트랜잭션에서 갱신한다(NF-02).
pub fn save_page(conn: &mut Connection, id: i64, content: &Value) -> AppResult<UpdatedAt> {
    let body = extract_text(content);
    let json = content.to_string();
    let tx = conn.transaction()?;
    let now = now_ms();
    let n = tx.execute(
        "UPDATE pages SET content = ?1, updated_at = ?2 WHERE id = ?3 AND trashed_at IS NULL",
        params![json, now, id],
    )?;
    if n == 0 {
        return Err(not_found(id));
    }
    tx.execute("UPDATE page_fts SET body = ?1 WHERE rowid = ?2", params![body, id])?;
    tx.commit()?;
    Ok(UpdatedAt { updated_at: now })
}

pub fn move_page(conn: &mut Connection, id: i64, new_parent_id: Option<i64>, new_position: i64) -> AppResult<()> {
    let tx = conn.transaction()?;
    ensure_alive(&tx, id)?;
    if let Some(p) = new_parent_id {
        let trashed: Option<Option<i64>> = tx
            .query_row("SELECT trashed_at FROM pages WHERE id = ?1", [p], |r| r.get(0))
            .optional()?;
        match trashed {
            None => return Err(not_found(p)),
            Some(Some(_)) => {
                return Err(AppError::new(ErrorKind::InvalidMove, "휴지통 페이지 아래로 옮길 수 없습니다"));
            }
            Some(None) => {}
        }
        // new_parent_id 자신과 조상 사슬에 id가 있으면 순환이다.
        let cycle: bool = tx.query_row(
            "WITH RECURSIVE anc(id) AS (
               SELECT ?1
               UNION
               SELECT p.parent_id FROM pages p JOIN anc ON p.id = anc.id WHERE p.parent_id IS NOT NULL
             )
             SELECT EXISTS(SELECT 1 FROM anc WHERE id = ?2)",
            params![p, id],
            |r| r.get(0),
        )?;
        if cycle {
            return Err(AppError::new(ErrorKind::InvalidMove, "자기 자신이나 하위 페이지 안으로 옮길 수 없습니다"));
        }
    }
    let old_parent = parent_of(&tx, id)?;
    insert_at(&tx, new_parent_id, id, new_position)?;
    if old_parent != new_parent_id {
        renumber(&tx, old_parent)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn set_expanded(conn: &Connection, id: i64, expanded: bool) -> AppResult<()> {
    let n = conn.execute(
        "UPDATE pages SET expanded = ?1 WHERE id = ?2 AND trashed_at IS NULL",
        params![expanded, id],
    )?;
    if n == 0 { Err(not_found(id)) } else { Ok(()) }
}

/// 대상과 살아 있는 하위 전체를 한 묶음으로 휴지통에 보낸다.
pub fn trash_page(conn: &mut Connection, id: i64) -> AppResult<TrashedCount> {
    let tx = conn.transaction()?;
    ensure_alive(&tx, id)?;
    let parent = parent_of(&tx, id)?;
    let n = tx.execute(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1
           UNION ALL
           SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.trashed_at IS NULL
         )
         UPDATE pages SET trashed_at = ?2, trash_root_id = ?1 WHERE id IN (SELECT id FROM sub)",
        params![id, now_ms()],
    )?;
    renumber(&tx, parent)?;
    tx.commit()?;
    Ok(TrashedCount { trashed_count: n as i64 })
}

pub fn list_trash(conn: &Connection) -> AppResult<Vec<TrashItem>> {
    let mut st = conn.prepare(
        "SELECT p.id, p.title, p.trashed_at,
                (SELECT count(*) FROM pages c WHERE c.trash_root_id = p.id) - 1
         FROM pages p
         WHERE p.trashed_at IS NOT NULL AND p.trash_root_id = p.id
         ORDER BY p.trashed_at DESC, p.id DESC",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(TrashItem { id: r.get(0)?, title: r.get(1)?, trashed_at: r.get(2)?, descendant_count: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// 휴지통 묶음 꼭대기의 (trashed_at, trash_root_id)를 확인한다.
fn ensure_trash_root(conn: &Connection, id: i64) -> AppResult<()> {
    let row: Option<(Option<i64>, Option<i64>)> = conn
        .query_row("SELECT trashed_at, trash_root_id FROM pages WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    match row {
        None => Err(not_found(id)),
        Some((None, _)) => Err(AppError::new(ErrorKind::InvalidInput, "휴지통에 있는 페이지가 아닙니다")),
        Some((_, root)) if root != Some(id) => {
            Err(AppError::new(ErrorKind::InvalidInput, "휴지통 묶음의 꼭대기 페이지가 아닙니다"))
        }
        Some(_) => Ok(()),
    }
}

/// 묶음 전체를 되살린다. 부모가 살아 있으면 원래 자리, 아니면 최상위 맨 끝(`to_root = true`).
pub fn restore_page(conn: &mut Connection, id: i64) -> AppResult<ToRoot> {
    let tx = conn.transaction()?;
    ensure_trash_root(&tx, id)?;
    let (parent, pos): (Option<i64>, i64) =
        tx.query_row("SELECT parent_id, position FROM pages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    tx.execute("UPDATE pages SET trashed_at = NULL, trash_root_id = NULL WHERE trash_root_id = ?1", [id])?;
    // 부모가 영구 삭제되면 FK가 parent_id를 NULL로 바꾸고, 삭제 때 position을 -1로 표시해 둔다.
    let parent_ok = match parent {
        Some(p) => is_alive(&tx, p)?,
        None => pos >= 0,
    };
    let (to, at) = if parent_ok { (parent, pos) } else { (None, i64::MAX) };
    insert_at(&tx, to, id, at)?;
    tx.commit()?;
    Ok(ToRoot { to_root: !parent_ok })
}

/// 휴지통 묶음을 지운다. 반환값은 커밋 뒤 지울 첨부 파일 이름.
pub fn delete_page_permanently(conn: &mut Connection, id: i64) -> AppResult<Vec<String>> {
    let tx = conn.transaction()?;
    ensure_trash_root(&tx, id)?;
    // 따로 휴지통에 간 하위 묶음: 부모가 사라졌다는 표시(복원 때 최상위 맨 끝으로)
    tx.execute(
        "UPDATE pages SET position = -1
         WHERE trashed_at IS NOT NULL AND trash_root_id IS NOT ?1
           AND parent_id IN (SELECT id FROM pages WHERE trash_root_id = ?1)",
        [id],
    )?;
    tx.execute("DELETE FROM pages WHERE trash_root_id = ?1", [id])?;
    let files = attachments::orphan_cleanup(&tx)?;
    tx.commit()?;
    Ok(files)
}

/// 휴지통 전체를 지운다. (지운 페이지 수, 지울 첨부 파일 이름)
pub fn empty_trash(conn: &mut Connection) -> AppResult<(i64, Vec<String>)> {
    let tx = conn.transaction()?;
    let n = tx.execute("DELETE FROM pages WHERE trashed_at IS NOT NULL", [])?;
    let files = attachments::orphan_cleanup(&tx)?;
    tx.commit()?;
    Ok((n as i64, files))
}

pub fn get_start_page_id(conn: &Connection) -> AppResult<Option<i64>> {
    let last: Option<String> = conn
        .query_row("SELECT value FROM app_state WHERE key = 'last_page_id'", [], |r| r.get(0))
        .optional()?;
    if let Some(id) = last.and_then(|v| v.parse::<i64>().ok()) {
        if is_alive(conn, id)? {
            return Ok(Some(id));
        }
    }
    Ok(conn
        .query_row(
            "SELECT id FROM pages WHERE parent_id IS NULL AND trashed_at IS NULL ORDER BY position LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_last_page(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES ('last_page_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [id.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn new(conn: &mut Connection, parent: Option<i64>) -> i64 {
        create_page(conn, parent).unwrap().id
    }

    /// (parent_id, 순서대로 id)
    fn kids(conn: &Connection, parent: Option<i64>) -> Vec<i64> {
        children(conn, parent, None).unwrap()
    }

    fn positions_dense(conn: &Connection) {
        let tree = list_tree(conn).unwrap();
        let mut parents: Vec<Option<i64>> = tree.iter().map(|n| n.parent_id).collect();
        parents.dedup();
        for p in parents {
            let pos: Vec<i64> = tree.iter().filter(|n| n.parent_id == p).map(|n| n.position).collect();
            assert_eq!(pos, (0..pos.len() as i64).collect::<Vec<_>>(), "parent {p:?}");
        }
    }

    #[test]
    fn create_appends_and_expands_parent() {
        let mut c = open_memory();
        let a = new(&mut c, None);
        let b = new(&mut c, None);
        let a1 = new(&mut c, Some(a));
        assert_eq!(kids(&c, None), vec![a, b]);
        assert_eq!(kids(&c, Some(a)), vec![a1]);
        let page = get_page(&c, a1).unwrap();
        assert_eq!(page.title, "");
        assert_eq!(page.content, serde_json::from_str::<Value>(EMPTY_DOC).unwrap());
        assert!(list_tree(&c).unwrap().iter().find(|n| n.id == a).unwrap().expanded);
        assert_eq!(create_page(&mut c, Some(999)).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn move_rejects_cycles() {
        let mut c = open_memory();
        let a = new(&mut c, None);
        let b = new(&mut c, Some(a));
        let d = new(&mut c, Some(b));
        for target in [a, b, d] {
            let e = move_page(&mut c, a, Some(target), 0).unwrap_err();
            assert_eq!(e.kind, ErrorKind::InvalidMove, "a -> {target}");
        }
        assert_eq!(move_page(&mut c, b, Some(d), 0).unwrap_err().kind, ErrorKind::InvalidMove);
        // 트리는 그대로
        assert_eq!(kids(&c, None), vec![a]);
        assert_eq!(kids(&c, Some(b)), vec![d]);
        // 휴지통 페이지 아래로 이동 거부
        let x = new(&mut c, None);
        trash_page(&mut c, x).unwrap();
        assert_eq!(move_page(&mut c, d, Some(x), 0).unwrap_err().kind, ErrorKind::InvalidMove);
    }

    #[test]
    fn move_renumbers_old_and_new_siblings() {
        let mut c = open_memory();
        let a = new(&mut c, None);
        let b = new(&mut c, None);
        let x = new(&mut c, None);
        let b1 = new(&mut c, Some(b));
        // 같은 부모 안 순서 바꾸기
        move_page(&mut c, x, None, 0).unwrap();
        assert_eq!(kids(&c, None), vec![x, a, b]);
        // 다른 부모로, 범위 밖 위치는 맨 끝으로 잘린다
        move_page(&mut c, a, Some(b), 100).unwrap();
        assert_eq!(kids(&c, None), vec![x, b]);
        assert_eq!(kids(&c, Some(b)), vec![b1, a]);
        move_page(&mut c, a, Some(b), -5).unwrap();
        assert_eq!(kids(&c, Some(b)), vec![a, b1]);
        positions_dense(&c);
    }

    #[test]
    fn trash_bundle_and_restore_to_original_place() {
        let mut c = open_memory();
        let a = new(&mut c, None);
        let s1 = new(&mut c, Some(a));
        let b = new(&mut c, Some(a));
        let s2 = new(&mut c, Some(a));
        let b1 = new(&mut c, Some(b));
        let _b2 = new(&mut c, Some(b1));

        assert_eq!(trash_page(&mut c, b).unwrap().trashed_count, 3);
        assert_eq!(kids(&c, Some(a)), vec![s1, s2]);
        positions_dense(&c);
        assert!(list_tree(&c).unwrap().iter().all(|n| n.id != b && n.id != b1));
        let trash = list_trash(&c).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!((trash[0].id, trash[0].descendant_count), (b, 2));
        // 묶음 꼭대기가 아니면 복원·영구 삭제 거부, 휴지통 페이지 편집 거부
        assert_eq!(restore_page(&mut c, b1).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(delete_page_permanently(&mut c, a).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(save_page(&mut c, b1, &serde_json::json!({})).unwrap_err().kind, ErrorKind::NotFound);
        assert!(get_page(&c, b1).is_ok());

        assert!(!restore_page(&mut c, b).unwrap().to_root);
        assert_eq!(kids(&c, Some(a)), vec![s1, b, s2]);
        assert_eq!(kids(&c, Some(b)), vec![b1]);
        assert!(list_trash(&c).unwrap().is_empty());
        positions_dense(&c);
    }

    #[test]
    fn restore_goes_to_root_when_parent_deleted() {
        let mut c = open_memory();
        let r = new(&mut c, None);
        let a = new(&mut c, None);
        let child = new(&mut c, Some(a));
        let grand = new(&mut c, Some(child));
        trash_page(&mut c, child).unwrap(); // 하위 묶음을 먼저 따로 보냄
        trash_page(&mut c, a).unwrap();
        assert_eq!(list_trash(&c).unwrap().len(), 2);

        // 부모가 아직 휴지통이면 최상위로
        assert!(restore_page(&mut c, child).unwrap().to_root);
        assert_eq!(kids(&c, None), vec![r, child]);
        assert_eq!(kids(&c, Some(child)), vec![grand]);

        // 최상위 페이지는 원래 순서 자리로(to_root=false)
        trash_page(&mut c, r).unwrap();
        assert!(!restore_page(&mut c, r).unwrap().to_root);
        assert_eq!(kids(&c, None), vec![r, child]);

        // 부모가 영구 삭제되면 parent_id는 NULL이 되고 최상위 맨 끝으로
        let p2 = new(&mut c, None);
        let c2 = new(&mut c, Some(p2));
        move_page(&mut c, p2, None, 0).unwrap();
        trash_page(&mut c, c2).unwrap();
        trash_page(&mut c, p2).unwrap();
        delete_page_permanently(&mut c, a).unwrap();
        delete_page_permanently(&mut c, p2).unwrap();
        assert_eq!(list_trash(&c).unwrap().len(), 1);
        assert_eq!(get_page(&c, c2).unwrap().parent_id, None);
        assert!(restore_page(&mut c, c2).unwrap().to_root);
        assert_eq!(kids(&c, None), vec![r, child, c2]);
        positions_dense(&c);
    }

    #[test]
    fn empty_trash_deletes_all_and_index_rows() {
        let mut c = open_memory();
        let a = new(&mut c, None);
        let _a1 = new(&mut c, Some(a));
        let b = new(&mut c, None);
        trash_page(&mut c, a).unwrap();
        trash_page(&mut c, b).unwrap();
        assert_eq!(empty_trash(&mut c).unwrap().0, 3);
        let fts: i64 = c.query_row("SELECT count(*) FROM page_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
        assert!(list_trash(&c).unwrap().is_empty());
    }

    #[test]
    fn save_page_updates_content_and_index_together() {
        let mut c = open_memory();
        let id = new(&mut c, None);
        let doc = serde_json::json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"첫 문단 사과나무"}]},
            {"type":"paragraph","content":[{"type":"text","text":"둘째"}]}
        ]});
        let u = save_page(&mut c, id, &doc).unwrap();
        let page = get_page(&c, id).unwrap();
        assert_eq!(page.content, doc);
        assert_eq!(page.updated_at, u.updated_at);
        let body: String = c.query_row("SELECT body FROM page_fts WHERE rowid = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(body, "첫 문단 사과나무\n둘째\n\n");

        rename_page(&mut c, id, "  새 제목  ").unwrap();
        assert_eq!(get_page(&c, id).unwrap().title, "새 제목");
        let t: String = c.query_row("SELECT title FROM page_fts WHERE rowid = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(t, "새 제목");
        assert_eq!(save_page(&mut c, 999, &doc).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn start_page_falls_back_to_first_root() {
        let mut c = open_memory();
        assert_eq!(get_start_page_id(&c).unwrap(), None);
        let a = new(&mut c, None);
        let b = new(&mut c, None);
        assert_eq!(get_start_page_id(&c).unwrap(), Some(a));
        set_last_page(&c, b).unwrap();
        assert_eq!(get_start_page_id(&c).unwrap(), Some(b));
        trash_page(&mut c, b).unwrap();
        assert_eq!(get_start_page_id(&c).unwrap(), Some(a));
        set_expanded(&c, a, true).unwrap();
        assert_eq!(set_expanded(&c, b, true).unwrap_err().kind, ErrorKind::NotFound);
    }
}
