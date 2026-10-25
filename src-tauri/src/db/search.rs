//! 평문 추출(계약 6절)과 전문 검색(계약 7절).
use crate::error::AppResult;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use serde_json::Value;

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 500;
/// LIKE 검색 결과에서 일치 부분 앞뒤로 남길 글자 수.
const CONTEXT_CHARS: usize = 30;
/// snippet()이 일치 부분을 감싸는 표시. 본문에 거의 나오지 않는 제어 문자.
const OPEN: char = '\u{2}';
const CLOSE: char = '\u{3}';

#[derive(Debug, PartialEq, Serialize)]
pub struct Segment {
    pub text: String,
    #[serde(rename = "match")]
    pub is_match: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page_id: i64,
    pub title: String,
    pub snippet: Vec<Segment>,
}

/// TipTap JSON의 모든 `text`를 모으고, `content`를 가진 노드가 끝날 때마다 줄바꿈을 넣는다.
pub fn extract_text(doc: &Value) -> String {
    fn walk(v: &Value, out: &mut String) {
        if let Some(t) = v.get("text").and_then(Value::as_str) {
            out.push_str(t);
        }
        if let Some(children) = v.get("content").and_then(Value::as_array) {
            for c in children {
                walk(c, out);
            }
            out.push('\n');
        }
    }
    let mut out = String::new();
    walk(doc, &mut out);
    out
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn search(conn: &Connection, query: &str, limit: Option<u32>) -> AppResult<Vec<SearchHit>> {
    let (long, short): (Vec<&str>, Vec<&str>) = query.split_whitespace().partition(|t| t.chars().count() >= 3);
    if long.is_empty() && short.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<SqlValue> = Vec::new();
    let mut conds = vec!["p.trashed_at IS NULL".to_string()];
    if !long.is_empty() {
        let expr = long
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        args.push(SqlValue::Text(expr));
        conds.push(format!("page_fts MATCH ?{}", args.len()));
    }
    for t in &short {
        args.push(SqlValue::Text(format!("%{}%", escape_like(t))));
        let n = args.len();
        conds.push(format!("(page_fts.title LIKE ?{n} ESCAPE '\\' OR page_fts.body LIKE ?{n} ESCAPE '\\')"));
    }
    args.push(SqlValue::Integer(limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as i64));
    let lim = args.len();
    let conds = conds.join(" AND ");

    if !long.is_empty() {
        let sql = format!(
            "SELECT p.id, p.title, snippet(page_fts, -1, char(2), char(3), '…', 32)
             FROM page_fts JOIN pages p ON p.id = page_fts.rowid
             WHERE {conds} ORDER BY bm25(page_fts) LIMIT ?{lim}"
        );
        let mut st = conn.prepare(&sql)?;
        let hits = st
            .query_map(params_from_iter(args), |r| {
                Ok(SearchHit { page_id: r.get(0)?, title: r.get(1)?, snippet: parse_marked(&r.get::<_, String>(2)?) })
            })?
            .collect::<Result<_, _>>()?;
        Ok(hits)
    } else {
        let sql = format!(
            "SELECT p.id, p.title, page_fts.body
             FROM page_fts JOIN pages p ON p.id = page_fts.rowid
             WHERE {conds} ORDER BY p.updated_at DESC, p.id DESC LIMIT ?{lim}"
        );
        let mut st = conn.prepare(&sql)?;
        let rows: Vec<(i64, String, String)> = st
            .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(page_id, title, body)| {
                let snippet = like_snippet(&body, &short)
                    .or_else(|| like_snippet(&title, &short))
                    .unwrap_or_default();
                SearchHit { page_id, title, snippet }
            })
            .collect())
    }
}

/// `buf`가 비어 있지 않으면 조각 하나로 내보내고 비운다.
fn flush(buf: &mut String, is_match: bool, out: &mut Vec<Segment>) {
    if !buf.is_empty() {
        out.push(Segment { text: std::mem::take(buf), is_match });
    }
}

/// snippet()의 OPEN/CLOSE 표시를 조각 배열로 바꾼다.
fn parse_marked(s: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_match = false;
    for ch in s.chars() {
        match ch {
            OPEN => {
                flush(&mut buf, false, &mut out);
                in_match = true;
            }
            CLOSE => {
                flush(&mut buf, true, &mut out);
                in_match = false;
            }
            _ => buf.push(ch),
        }
    }
    flush(&mut buf, in_match, &mut out);
    out
}

/// 첫 일치 위치 앞뒤 약 30자를 잘라 조각으로 만든다. SQLite LIKE처럼 ASCII만 대소문자를 무시한다.
fn like_snippet(text: &str, terms: &[&str]) -> Option<Vec<Segment>> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let pats: Vec<Vec<char>> = terms.iter().map(|t| t.chars().map(|c| c.to_ascii_lowercase()).collect()).collect();
    let match_len = |i: usize| pats.iter().filter(|p| lower[i..].starts_with(p)).map(|p| p.len()).max();

    let first = (0..chars.len()).find(|&i| match_len(i).is_some())?;
    let start = first.saturating_sub(CONTEXT_CHARS);
    let end = (first + CONTEXT_CHARS).min(chars.len());

    let mut out = Vec::new();
    let mut plain = String::new();
    if start > 0 {
        plain.push('…');
    }
    let mut i = start;
    while i < end {
        if let Some(len) = match_len(i) {
            flush(&mut plain, false, &mut out);
            out.push(Segment { text: chars[i..i + len].iter().collect(), is_match: true });
            i += len;
        } else {
            plain.push(chars[i]);
            i += 1;
        }
    }
    if i < chars.len() {
        plain.push('…');
    }
    flush(&mut plain, false, &mut out);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_memory, pages};
    use serde_json::json;

    fn doc(text: &str) -> Value {
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
    }

    fn add(c: &mut Connection, title: &str, body: &str) -> i64 {
        let id = pages::create_page(c, None).unwrap().id;
        pages::rename_page(c, id, title).unwrap();
        pages::save_page(c, id, &doc(body)).unwrap();
        id
    }

    fn ids(hits: &[SearchHit]) -> Vec<i64> {
        let mut v: Vec<i64> = hits.iter().map(|h| h.page_id).collect();
        v.sort();
        v
    }

    fn matched(hit: &SearchHit) -> Vec<String> {
        hit.snippet.iter().filter(|s| s.is_match).map(|s| s.text.clone()).collect()
    }

    #[test]
    fn extract_text_joins_blocks_with_newlines() {
        let d = json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"제목"}]},
            {"type":"bulletList","content":[{"type":"listItem","content":[
                {"type":"paragraph","content":[{"type":"text","text":"하나 "},{"type":"text","marks":[{"type":"bold"}],"text":"굵게"}]}
            ]}]},
            {"type":"image","attrs":{"src":"12.png"}},
            {"type":"paragraph"}
        ]});
        assert_eq!(extract_text(&d), "제목\n하나 굵게\n\n\n\n");
    }

    #[test]
    fn three_plus_chars_use_match() {
        let mut c = open_memory();
        let a = add(&mut c, "주간 정리", "오늘 회의록에서 결정한 내용. Hello World");
        let b = add(&mut c, "회의록 모음", "다른 내용");
        let _x = add(&mut c, "무관", "전혀 관계없는 글");

        assert_eq!(ids(&search(&c, "회의록", None).unwrap()), vec![a, b]);
        let hits = search(&c, "의록에", None).unwrap(); // 어절 중간
        assert_eq!(ids(&hits), vec![a]);
        assert_eq!(matched(&hits[0]), vec!["의록에"]);
        assert_eq!(ids(&search(&c, "HELLO", None).unwrap()), vec![a]);
        assert_eq!(ids(&search(&c, "회의록 결정한", None).unwrap()), vec![a]); // AND
        assert_eq!(ids(&search(&c, "\"회의록", None).unwrap()), Vec::<i64>::new()); // 따옴표 이스케이프
        assert!(search(&c, "   ", None).unwrap().is_empty());
        assert_eq!(search(&c, "회의록", Some(1)).unwrap().len(), 1);

        pages::trash_page(&mut c, b).unwrap();
        assert_eq!(ids(&search(&c, "회의록", None).unwrap()), vec![a]);
    }

    #[test]
    fn one_or_two_chars_use_like() {
        let mut c = open_memory();
        let a = add(&mut c, "주간", "오늘 회의록에서 결정한 내용. Hello World");
        let b = add(&mut c, "회의", "다른 내용");
        let p = add(&mut c, "할인", "100% 확정");

        assert_eq!(ids(&search(&c, "회의", None).unwrap()), vec![a, b]);
        assert_eq!(ids(&search(&c, "회", None).unwrap()), vec![a, b]);
        let hits = search(&c, "HE", None).unwrap();
        assert_eq!(ids(&hits), vec![a]);
        assert_eq!(matched(&hits[0]), vec!["He"]);
        // 제목에만 있으면 제목에서 조각을 뽑는다
        let hits = search(&c, "회의", None).unwrap();
        let hb = hits.iter().find(|h| h.page_id == b).unwrap();
        assert_eq!(matched(hb), vec!["회의"]);
        // % 는 와일드카드가 아니라 글자
        assert_eq!(ids(&search(&c, "%", None).unwrap()), vec![p]);
        assert_eq!(ids(&search(&c, "0%", None).unwrap()), vec![p]);
        // 짧은 단어 + 긴 단어 AND
        assert_eq!(ids(&search(&c, "회 결정한", None).unwrap()), vec![a]);

        pages::trash_page(&mut c, a).unwrap();
        assert_eq!(ids(&search(&c, "회의", None).unwrap()), vec![b]);
    }

    #[test]
    fn like_snippet_cuts_around_first_match() {
        let text = format!("{}회의{}", "가".repeat(40), "나".repeat(40));
        let seg = like_snippet(&text, &["회의"]).unwrap();
        assert_eq!(seg.len(), 3);
        assert_eq!(seg[0].text, format!("…{}", "가".repeat(30)));
        assert_eq!(seg[1], Segment { text: "회의".into(), is_match: true });
        assert_eq!(seg[2].text, format!("{}…", "나".repeat(28)));
        assert!(like_snippet("없음", &["회의"]).is_none());
    }

    #[test]
    fn parse_marked_splits_segments() {
        let s = format!("오늘 {OPEN}회의록{CLOSE}에서 결…");
        assert_eq!(
            parse_marked(&s),
            vec![
                Segment { text: "오늘 ".into(), is_match: false },
                Segment { text: "회의록".into(), is_match: true },
                Segment { text: "에서 결…".into(), is_match: false },
            ]
        );
    }
}
