//! AI 관련 SQL(계약-AI 0·3절, 계약-DB v2 4.1절): 키 끝 4자리, 하루 상한, 사용 기록, 전송 제외.
use super::pages::ensure_alive;
use crate::error::{AppError, AppResult, ErrorKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const LAST4: &str = "api_key_last4";
const DAILY_LIMIT: &str = "ai_daily_limit";
const DEFAULT_DAILY_LIMIT: i64 = 50;

fn get_state(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM app_state WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

fn set_state(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub fn key_last4(conn: &Connection) -> AppResult<Option<String>> {
    get_state(conn, LAST4)
}

pub fn set_key_last4(conn: &Connection, last4: Option<&str>) -> AppResult<()> {
    match last4 {
        Some(v) => set_state(conn, LAST4, v),
        None => {
            conn.execute("DELETE FROM app_state WHERE key = ?1", [LAST4])?;
            Ok(())
        }
    }
}

/// 없거나 읽을 수 없으면 50.
pub fn daily_limit(conn: &Connection) -> AppResult<i64> {
    Ok(get_state(conn, DAILY_LIMIT)?.and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_DAILY_LIMIT))
}

pub fn set_daily_limit(conn: &Connection, limit: i64) -> AppResult<()> {
    if !(1..=1000).contains(&limit) {
        return Err(AppError::new(ErrorKind::InvalidInput, "하루 상한은 1~1000이어야 합니다"));
    }
    set_state(conn, DAILY_LIMIT, &limit.to_string())
}

pub fn calls_on(conn: &Connection, day: &str) -> AppResult<i64> {
    Ok(conn
        .query_row("SELECT calls FROM ai_usage WHERE day = ?1", [day], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// 요청 1회와 입력 글자 수를 더한다. 노트 내용은 남기지 않는다.
pub fn record_usage(conn: &Connection, day: &str, input_chars: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO ai_usage (day, calls, input_chars) VALUES (?1, 1, ?2)
         ON CONFLICT(day) DO UPDATE SET calls = calls + 1, input_chars = input_chars + excluded.input_chars",
        params![day, input_chars],
    )?;
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageDay {
    day: String,
    calls: i64,
    input_chars: i64,
}

/// 최근 `days`개 날짜, 최신순.
pub fn list_usage(conn: &Connection, days: u32) -> AppResult<Vec<AiUsageDay>> {
    Ok(conn
        .prepare("SELECT day, calls, input_chars FROM ai_usage ORDER BY day DESC LIMIT ?1")?
        .query_map([days], |r| Ok(AiUsageDay { day: r.get(0)?, calls: r.get(1)?, input_chars: r.get(2)? }))?
        .collect::<Result<_, _>>()?)
}

/// 화면에는 `"none"`·`"self"`·`"ancestor"`로 간다(계약-AI `AiStatus.excluded`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Excluded {
    None,
    /// 자기 `ai_exclude`가 1(이 페이지만) 또는 2(하위 포함)
    #[serde(rename = "self")]
    Own,
    /// 조상 중 하나가 2(하위 포함)
    Ancestor,
}

/// 페이지 자기의 `ai_exclude` 값(설정 화면의 선택값). 화면에는 `"none"`·`"self"`·`"subtree"`로 간다.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExcludeMode {
    None,
    #[serde(rename = "self")]
    Own,
    Subtree,
}

/// 없는 페이지면 `NotFound`.
pub fn exclude_mode(conn: &Connection, page_id: i64) -> AppResult<ExcludeMode> {
    let own: i64 = conn
        .query_row("SELECT ai_exclude FROM pages WHERE id = ?1", [page_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("페이지 {page_id}가 없습니다")))?;
    Ok(match own {
        0 => ExcludeMode::None,
        1 => ExcludeMode::Own,
        _ => ExcludeMode::Subtree,
    })
}

/// 실제 제외 여부(계약-AI 3.1). 없는 페이지면 `NotFound`.
pub fn exclusion(conn: &Connection, page_id: i64) -> AppResult<Excluded> {
    if exclude_mode(conn, page_id)? != ExcludeMode::None {
        return Ok(Excluded::Own);
    }
    let by_ancestor: bool = conn.query_row(
        "WITH RECURSIVE anc(id) AS (
           SELECT parent_id FROM pages WHERE id = ?1
           UNION SELECT p.parent_id FROM pages p JOIN anc ON p.id = anc.id
         )
         SELECT EXISTS (SELECT 1 FROM pages WHERE id IN (SELECT id FROM anc) AND ai_exclude = 2)",
        [page_id],
        |r| r.get(0),
    )?;
    Ok(if by_ancestor { Excluded::Ancestor } else { Excluded::None })
}

/// `mode`: 0 = 없음, 1 = 이 페이지만, 2 = 이 페이지와 하위 전체.
pub fn set_exclude(conn: &Connection, page_id: i64, mode: i64) -> AppResult<()> {
    ensure_alive(conn, page_id)?;
    conn.execute("UPDATE pages SET ai_exclude = ?1 WHERE id = ?2", params![mode, page_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pages::{create_page, trash_page};

    /// TODO(NOTE-backend1의 V2 병합 뒤 삭제): 이 가지에는 아직 V2 마이그레이션이 없어 테스트에서만 같은 DDL을 덧붙인다.
    fn conn() -> Connection {
        let c = crate::db::open_memory();
        let has_v2: bool = c
            .query_row("SELECT count(*) > 0 FROM pragma_table_info('pages') WHERE name = 'ai_exclude'", [], |r| r.get(0))
            .unwrap();
        if !has_v2 {
            c.execute_batch(
                "ALTER TABLE pages ADD COLUMN ai_exclude INTEGER NOT NULL DEFAULT 0 CHECK (ai_exclude IN (0, 1, 2));
                 CREATE TABLE ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
                   input_chars INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;",
            )
            .unwrap();
        }
        c
    }

    #[test]
    fn last4_roundtrip() {
        let conn = conn();
        assert_eq!(key_last4(&conn).unwrap(), None);
        set_key_last4(&conn, Some("abcd")).unwrap();
        set_key_last4(&conn, Some("wxyz")).unwrap();
        assert_eq!(key_last4(&conn).unwrap().as_deref(), Some("wxyz"));
        set_key_last4(&conn, None).unwrap();
        set_key_last4(&conn, None).unwrap();
        assert_eq!(key_last4(&conn).unwrap(), None);
    }

    #[test]
    fn daily_limit_bounds() {
        let conn = conn();
        assert_eq!(daily_limit(&conn).unwrap(), 50);
        for bad in [0, -1, 1001] {
            assert_eq!(set_daily_limit(&conn, bad).unwrap_err().kind, ErrorKind::InvalidInput);
        }
        set_daily_limit(&conn, 1).unwrap();
        assert_eq!(daily_limit(&conn).unwrap(), 1);
        set_daily_limit(&conn, 1000).unwrap();
        assert_eq!(daily_limit(&conn).unwrap(), 1000);
    }

    #[test]
    fn usage_counts_per_day() {
        let conn = conn();
        assert_eq!(calls_on(&conn, "2026-10-26").unwrap(), 0);
        record_usage(&conn, "2026-10-25", 10).unwrap();
        record_usage(&conn, "2026-10-26", 3).unwrap();
        record_usage(&conn, "2026-10-26", 4).unwrap();
        assert_eq!(calls_on(&conn, "2026-10-26").unwrap(), 2);
        let all = list_usage(&conn, 30).unwrap();
        assert_eq!(
            all,
            [
                AiUsageDay { day: "2026-10-26".into(), calls: 2, input_chars: 7 },
                AiUsageDay { day: "2026-10-25".into(), calls: 1, input_chars: 10 },
            ]
        );
        assert_eq!(list_usage(&conn, 1).unwrap().len(), 1);
    }

    #[test]
    fn exclusion_inherits_subtree_only() {
        let mut conn = conn();
        let a = create_page(&mut conn, None).unwrap().id;
        let b = create_page(&mut conn, Some(a)).unwrap().id;
        let c = create_page(&mut conn, Some(b)).unwrap().id;
        assert_eq!(exclusion(&conn, c).unwrap(), Excluded::None);
        set_exclude(&conn, a, 1).unwrap();
        assert_eq!(exclusion(&conn, a).unwrap(), Excluded::Own);
        assert_eq!(exclusion(&conn, c).unwrap(), Excluded::None, "'이 페이지만'은 상속하지 않는다");
        assert_eq!(exclude_mode(&conn, a).unwrap(), ExcludeMode::Own);
        set_exclude(&conn, a, 2).unwrap();
        assert_eq!(exclude_mode(&conn, a).unwrap(), ExcludeMode::Subtree);
        assert_eq!(exclude_mode(&conn, b).unwrap(), ExcludeMode::None);
        assert_eq!(exclusion(&conn, b).unwrap(), Excluded::Ancestor);
        assert_eq!(exclusion(&conn, c).unwrap(), Excluded::Ancestor);
        let d = create_page(&mut conn, Some(c)).unwrap().id;
        assert_eq!(exclusion(&conn, d).unwrap(), Excluded::Ancestor, "새 하위도 제외");
        set_exclude(&conn, a, 0).unwrap();
        assert_eq!(exclusion(&conn, d).unwrap(), Excluded::None);
        assert_eq!(exclusion(&conn, 999).unwrap_err().kind, ErrorKind::NotFound);
        let names = [Excluded::None, Excluded::Own, Excluded::Ancestor].map(|e| serde_json::to_value(e).unwrap());
        assert_eq!(names, ["none", "self", "ancestor"]);
        let modes = [ExcludeMode::None, ExcludeMode::Own, ExcludeMode::Subtree].map(|m| serde_json::to_value(m).unwrap());
        assert_eq!(modes, ["none", "self", "subtree"]);
        assert_eq!(set_exclude(&conn, 999, 1).unwrap_err().kind, ErrorKind::NotFound);
        trash_page(&mut conn, c).unwrap();
        assert!(set_exclude(&conn, c, 1).is_err());
    }
}
