# DB 계층·Tauri 명령 계약 (v2, P3-1)

상태: **v1 확정(2026-10-26, 카드 20261026-0100-NOTE-pm-p1-db-contract, 9절). v2 확정(2026-10-26, 사용자 결정, 카드 20261026-0845-NOTE-pm-db-v2-contract: 초안대로, 11절 ①~⑤는 추천안대로). v2에서 바뀐 곳은 11절에 모았고 본문에는 `[v2]`로 표시했다.** 작성 NOTE-backend1.
v2 근거: 사용자 카드 결정(db-v2·security·ai-contract·ui-design 모두 추천안), 개정대기.md 카드 1·2-②·2-③·4-④, 계약-AI.md 3.1·4.1.
근거: D-06(SQLite만), 카드 20261026-0105(rusqlite + Tauri 명령, SQL은 Rust 한곳), F-01~F-01.4, F-02.6, F-04, F-05, F-07, NF-01~NF-04, D-14.

## 0. 원칙
- 화면(`src/`)은 SQL을 모른다. `invoke('<명령>')`만 호출한다. SQL·트랜잭션·평문 추출은 모두 `src-tauri/src/db/`에 있다.
- 승인된 추가 의존성은 `rusqlite`(feature `bundled`), `tauri-plugin-window-state`, `tauri-plugin-single-instance`(npm 쪽 짝 패키지 포함)까지다(9절). 그 밖의 crate는 [결정 요청]을 거친다. 시각은 `std::time::SystemTime`, JSON은 이미 있는 `serde_json`, 오류 타입은 직접 구현한다(`thiserror` 등을 쓰지 않음).

## 1. rusqlite + FTS5 trigram 확인 (실행 결과)
저장소 밖 임시 cargo 프로젝트에서 `cargo add rusqlite --features bundled`(→ rusqlite 0.41.0, libsqlite3-sys 0.39.1)로 메모리 DB를 열고 실행했다(2026-10-26).

| 확인 | 결과 |
|---|---|
| `select sqlite_version()` | 3.54.1 (trigram 필요 조건 3.34 이상) |
| `pragma compile_options`의 FTS 항목 | `ENABLE_FTS3`, `ENABLE_FTS3_PARENTHESIS`, `ENABLE_FTS5` |
| `create virtual table t using fts5(title, body, tokenize='trigram')` | 성공 |
| 본문 "오늘 회의록에서 결정한 내용. Hello World"에서 MATCH `"회의록"`, `"의록에"`(어절 중간), `"결정한"`, `"hello"` | 모두 1건 |
| MATCH `"HELLO"` | 1건 (대소문자 구분 없음, 기본값 `case_sensitive 0`) |
| MATCH `"회의"`, `"회"` (3글자 미만) | **0건** (공식 문서대로) |
| LIKE `%회의%`, `%회%`, `%HELLO%` | 모두 1건 |
| `snippet(t, 1, '[', ']', '…', 8)` | `오늘 [회의록]에서 결…` |
| `explain query plan … body like '%회의%'` | `SCAN t VIRTUAL TABLE INDEX 0:L1` (3글자 미만은 색인 없이 전체 훑기) |

**결론: feature는 `bundled` 하나면 된다.** 추가 feature나 컴파일 플래그는 필요 없다. bundled는 이 PC의 SQLite 설치와 상관없이 같은 버전을 앱에 넣는다.
Cargo.toml에 넣을 줄(공용 파일. 구현 시작 때 pm에 알리고 넣는다): `rusqlite = { version = "0.41", features = ["bundled"] }`

## 2. 파일 위치 (NF-01, D-14)
- 데이터 폴더: Rust `app.path().app_data_dir()` = `%APPDATA%\com.wynote.desktop\`. 앱 시작(setup) 때 `create_dir_all`로 만든다.
- DB: `<데이터 폴더>\wy-note.db` (WAL 모드라 실행 중에는 `wy-note.db-wal`, `wy-note.db-shm`이 옆에 생긴다)
- 첨부: `<데이터 폴더>\attachments\<파일 이름>`
- 마이그레이션 전 백업: `<데이터 폴더>\wy-note.db.bak-v<이전 버전>`

## 3. 연결 설정
- 앱 전체에 연결 1개. `tauri::State<Mutex<Connection>>`에 둔다(사용자 1명·창 1개라 연결 풀이 필요 없음).
- 열 때 실행: `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`
  - WAL + NORMAL: 커밋할 때 WAL에만 쓴다. 앱이 강제 종료돼도 커밋된 저장은 남고 DB가 깨지지 않는다(NF-02). 전원이 갑자기 꺼지면 마지막 몇 번의 커밋이 사라질 수 있지만 파일은 깨지지 않는다. 1초마다 저장(F-05)해도 디스크 동기화(fsync) 부담이 작다.
  - 앱이 정상 종료되면 SQLite가 WAL을 본 파일에 합치고 WAL 파일을 지운다. 그러면 "앱을 끈 상태에서 폴더 통째로 복사 = 백업"(NF-01)이 성립한다. 강제 종료 뒤에는 `-wal` 파일이 남는데, 이것도 같이 복사하면 된다.
- 명령은 `async fn`으로 만든다. Tauri 2에서 동기 명령은 메인 스레드에서 돌아 화면이 멈출 수 있다.

## 4. 스키마 v1

```sql
-- 페이지 트리 + 본문 (F-01, F-02, F-05)
CREATE TABLE pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- [v2] 지운 번호를 다시 쓰지 않는다(카드 1-①). JS number로 안전
  parent_id     INTEGER REFERENCES pages(id) ON DELETE SET NULL,  -- NULL = 최상위
  position      INTEGER NOT NULL,                  -- 형제 사이 순서. 살아 있는 형제끼리 0..n-1로 촘촘하게 유지
  title         TEXT    NOT NULL DEFAULT '',       -- '' 이면 화면이 "제목 없음"으로 보여 줌(F-01.2)
  content       TEXT    NOT NULL,                  -- TipTap JSON 문자열
  expanded      INTEGER NOT NULL DEFAULT 0,        -- 트리 펼침 상태(F-01, F-07)
  created_at    INTEGER NOT NULL,                  -- Unix 밀리초
  updated_at    INTEGER NOT NULL,
  trashed_at    INTEGER,                           -- NULL = 살아 있음, 값 = 휴지통에 간 시각(F-01.3)
  trash_root_id INTEGER                            -- 함께 휴지통에 간 묶음의 꼭대기 페이지 id
);
CREATE INDEX pages_children ON pages(parent_id, position) WHERE trashed_at IS NULL;
CREATE INDEX pages_trash    ON pages(trash_root_id)      WHERE trash_root_id IS NOT NULL;

-- 전문 검색 색인 (F-04). rowid = pages.id. 평문은 Rust가 TipTap JSON에서 뽑아 넣는다.
CREATE VIRTUAL TABLE page_fts USING fts5(title, body, tokenize='trigram');
CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  DELETE FROM page_fts WHERE rowid = old.id;
END;

-- 첨부 이미지 (F-02.6). 파일은 attachments 폴더, 본문에는 file_name만 둔다.
CREATE TABLE attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,      -- [v2] 파일 이름 '<id>.<확장자>'가 다른 이미지에 다시 쓰이지 않게
  page_id    INTEGER REFERENCES pages(id) ON DELETE SET NULL,  -- 처음 넣은 페이지(정리 판단용)
  file_name  TEXT    NOT NULL UNIQUE,              -- '<id>.<확장자>' 예: '12.png'
  mime       TEXT    NOT NULL,
  byte_size  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 앱 상태 (F-07). 키-값, 값은 JSON 문자열.
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- 키: 'last_page_id' → 숫자
-- [v2] 키 추가는 4.1절 표
```

### 4.1 [v2] 스키마 v2 (마이그레이션 2번 항목)
```sql
-- AI 전송 제외(F-08.5). 0 = 없음, 1 = 이 페이지만, 2 = 이 페이지와 하위 전체
ALTER TABLE pages ADD COLUMN ai_exclude INTEGER NOT NULL DEFAULT 0 CHECK (ai_exclude IN (0, 1, 2));

-- 날짜별 AI 사용 기록(F-08.5). 노트 내용은 남기지 않는다
CREATE TABLE ai_usage (
  day         TEXT    PRIMARY KEY,   -- 화면이 보낸 지역 날짜 'YYYY-MM-DD'
  calls       INTEGER NOT NULL DEFAULT 0,
  input_chars INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
```
- `ai_exclude`·`ai_usage`의 규칙(제외 상속, 횟수 세는 시점)은 계약-AI 3절을 따른다. 이 표들을 읽고 쓰는 SQL은 NOTE-backend2의 `db/ai.rs`에 둔다. 마이그레이션 항목(`db/migrations.rs` V2)은 NOTE-backend1이 쓴다.
- 휴지통으로 보내기·복원·이동은 `ai_exclude`를 바꾸지 않는다.

`app_state` 키 (값은 모두 JSON 문자열):

| 키 | 값 | 없을 때 | 읽고 쓰는 곳 |
|---|---|---|---|
| `last_page_id` | 숫자 | 트리 첫 페이지 | `get_start_page_id`·`set_last_page` (v1) |
| `ai_daily_limit` | 숫자 1~1000 | 50 | 계약-AI `set_ai_daily_limit`·`get_ai_status` |
| `api_key_last4` | 문자열(키 끝 4자리) | 키 없음 | 계약-AI `set_api_key`·`delete_api_key` |
| `ui_state` | `UiState` 객체(8절) | 화면 기본값 | `get_ui_state`·`set_ui_state` [v2] |

동작 규칙:
- **트리**: 살아 있는 형제의 `position`은 늘 0..n-1이다. 만들기·이동·휴지통·복원 때 같은 트랜잭션에서 형제 번호를 다시 매긴다. 형제는 많아야 수십 개라 부담이 없다.
- **휴지통으로(F-01.3)**: 대상과 살아 있는 하위 전체(재귀 CTE로 찾음)에 `trashed_at = now`, `trash_root_id = 대상 id`를 넣는다. `parent_id`·`position`은 그대로 둔다(복원 위치 기억용). 남은 형제는 번호를 다시 매긴다.
- **휴지통 목록**: 묶음의 꼭대기만 보인다(`trashed_at IS NOT NULL AND trash_root_id = id`). 하위 수는 같은 `trash_root_id`의 행 수 − 1이다.
- **복원**: 묶음 전체의 `trashed_at`·`trash_root_id`를 NULL로 되돌린다. 꼭대기의 부모가 살아 있으면 원래 `position`(형제 수로 잘라 냄)에 끼워 넣는다. 부모가 영구 삭제됐거나(이때 FK가 `parent_id`를 NULL로 바꿈) 아직 휴지통에 있으면 최상위 맨 끝에 둔다.
- **영구 삭제·휴지통 비우기**: 묶음을 `DELETE`한다. 트리거가 색인 행을 지운다. 따로 휴지통에 간 하위 묶음은 FK로 `parent_id`가 NULL이 되어, 나중에 복원하면 최상위로 간다(완료 기준과 맞음).
- **첨부 정리**: 영구 삭제 트랜잭션 안에서 `page_id IS NULL`이 된 첨부를 고른다. 남은 페이지(휴지통 포함) 중 `instr(content, file_name) > 0`인 것이 있으면 `page_id`를 그 페이지로 옮긴다. 없으면 행을 지우고, 커밋한 뒤 파일을 지운다. 파일 지우기에 실패하면 고아 파일만 남고 데이터에는 해가 없다.
  - 편집 중에 본문에서 이미지를 지워도 파일은 남는다(실행 취소로 되살릴 수 있어야 하므로). 이렇게 남는 파일은 MVP에서 정리하지 않는다.
- **검색 색인 대상**: 휴지통 페이지도 색인에 남긴다. 검색할 때 `pages.trashed_at IS NULL`로 거른다. 그래서 휴지통으로 보내거나 복원할 때 색인을 건드리지 않는다.

## 5. 마이그레이션
- 버전은 `PRAGMA user_version`. 스키마 SQL은 `src-tauri/src/db/migrations.rs`의 `const MIGRATIONS: &[&str]`에 순서대로 둔다(v1 = 위 4절).
- 앱 시작 때:
  1. `user_version`을 읽는다. 0이면 새 DB다.
  2. `user_version > MIGRATIONS.len()`이면(더 새 앱이 만든 DB) 열지 않는다. `Migration` 오류를 화면에 띄운다.
  3. 기존 DB(버전 1 이상)에 적용할 것이 있으면 먼저 `VACUUM INTO '<데이터 폴더>\wy-note.db.bak-v<버전>'`으로 백업한다.
  4. 남은 마이그레이션마다 트랜잭션 하나에서 `execute_batch(sql)`과 `PRAGMA user_version = n`을 함께 실행한다. 실패하면 롤백하고 오류를 띄운다.
- 마이그레이션 SQL은 한 번 배포하면 고치지 않는다. 바꿀 것은 새 항목으로 덧붙인다.
- [v2] 예외 하나: v1에 `AUTOINCREMENT`를 붙이는 것은 v1 항목을 직접 고친다(배포 전, 카드 1-①). 그래서 이 PC에서 개발·QA로 이미 만든 v1 DB(`user_version = 1`)는 `AUTOINCREMENT` 없이 남는다. 그 DB는 지우고 새로 만든다(실제 노트 없음, 11절 확인 ②).

## 6. 평문 추출 (F-04)
- `save_page`가 받은 TipTap JSON(`serde_json::Value`)을 Rust가 훑는다. 모든 `"text"` 문자열을 모으고, 블록 노드(`content`를 가진 노드)가 끝날 때마다 줄바꿈을 넣는다. 노드 종류를 몰라도 되므로 블록이 늘어도 고칠 필요가 없다.
- 이미지 노드는 텍스트가 없어 색인에 들어가지 않는다(F-27 후순위와 맞음).
- 프론트가 `editor.getText()`를 같이 보내는 방식보다 낫다고 본 이유: 색인 재구축(마이그레이션 때)을 Rust 혼자 할 수 있다. 평문 규칙도 한곳에만 있다.

## 7. 검색 (F-04)
- 검색어를 공백으로 나눈다. 3글자 이상 단어는 FTS MATCH 구문(`"단어"`, 큰따옴표는 두 번 써서 이스케이프)으로 AND 결합한다. 1~2글자 단어는 `(f.title LIKE ?1 ESCAPE '\' OR f.body LIKE ?1 ESCAPE '\')` 조건으로 AND 결합한다(`%`·`_`·`\` 이스케이프).
- MATCH 단어가 하나라도 있으면 `bm25(page_fts)`로 정렬하고 일치 부분은 `snippet()`으로 뽑는다. LIKE 단어만 있으면 `updated_at DESC`로 정렬하고 일치 부분은 Rust에서 찾아 앞뒤 약 30자를 자른다.
- 항상 `JOIN pages p ON p.id = f.rowid WHERE p.trashed_at IS NULL`로 휴지통을 뺀다. 기본 최대 50건이다.
- 일치 부분은 HTML이 아니라 조각 배열로 돌려준다. 화면은 이것을 텍스트로만 그리므로 본문 속 `<`가 HTML로 해석될 위험이 없다.
- 1~2글자 LIKE의 0.5초 기준(NF-04)은 구현 때 페이지 1,000개·1,000만 자 시험 데이터로 잰다.

## 8. 명령 계약

공통:
- 이름은 Rust 함수 이름(snake_case)이다. JS 인자는 Tauri 기본 규칙대로 camelCase로 쓴다(Rust `page_id` ↔ JS `pageId`).
- 반환 객체의 필드도 camelCase다(`#[serde(rename_all = "camelCase")]`).
- ID는 `number`(SQLite INTEGER), 시각은 Unix 밀리초 `number`.
- 실패하면 `invoke`가 아래 `AppError`로 reject한다.

```ts
// src/lib/db-types.ts (구현 때 프론트와 함께 만든다)
export type PageId = number;

export type AppError = {
  kind:
    | "NotFound"      // 없는 페이지·첨부, 또는 휴지통 페이지에 편집 명령
    | "InvalidMove"   // 자기 자신·하위로 이동, 휴지통 페이지로 이동
    | "InvalidInput"  // 잘못된 인자(빈 파일, 지원하지 않는 이미지 형식 등)
    | "Db"            // SQLite 오류(디스크 가득 참 등). F-05: 화면이 알리고 다음 저장 때 다시 시도
    | "Io"            // 파일 읽기·쓰기 오류(첨부·데이터 폴더)
    | "Migration"     // 시작 때 마이그레이션 실패, 더 새 버전 DB
    | "FileTooLarge"  // [v2] 첨부가 20MB 초과(카드 2-②)
    | "UnsupportedType" // [v2] 허용 밖 이미지 형식(svg·bmp·ico·heic 등)
    | AiErrorKind;    // [v2] 계약-AI 4.1의 14개(NoApiKey … Cancelled). NOTE-backend2가 error.rs에 더한다
  message: string;    // 개발자용 설명(한국어). 노트 본문은 넣지 않는다
};

export type TreeNode = {
  id: PageId;
  parentId: PageId | null;
  position: number;
  title: string;
  expanded: boolean;
};

export type Page = {
  id: PageId;
  parentId: PageId | null;
  title: string;
  content: JSONContent;   // @tiptap/core의 JSONContent
  createdAt: number;
  updatedAt: number;
};

export type TrashItem = {
  id: PageId;             // 묶음의 꼭대기
  title: string;
  trashedAt: number;
  descendantCount: number;
  parentId: PageId | null;  // [v2] 원래 부모. 최상위였거나 부모가 영구 삭제됐으면 null
  path: string[];           // [v2] 원래 위치: 최상위부터 부모까지 제목. [] = 최상위. '' 제목은 화면이 "제목 없음"으로
  restoresToRoot: boolean;  // [v2] 지금 복원하면 원래 자리 대신 최상위로 가는가(부모가 아직 휴지통이거나 영구 삭제됨). 처음부터 최상위였던 페이지는 false(원래 자리 = 최상위). restore_page의 toRoot와 같다
};

// [v2] 화면 상태(F-07 확장, 카드 1-④). Rust는 내용을 해석하지 않고 그대로 저장한다
export type UiState = {
  theme?: "system" | "light" | "dark";
  sidebarWidth?: number;      // 200~360
  sidebarCollapsed?: boolean;
  aiPanelOpen?: boolean;
  aiPanelWidth?: number;      // 300~480
  recentPageIds?: PageId[];   // 최근 연 페이지(최대 5). 지운 페이지 거르기는 화면이 list_tree로
};

export type SearchHit = {
  pageId: PageId;
  title: string;
  snippet: { text: string; match: boolean }[];  // 이어 붙이면 본문 일부. match=true가 강조할 부분
};
```

| 명령 | 인자 | 반환 | 트랜잭션·규칙 | 기능 |
|---|---|---|---|---|
| `list_tree` | 없음 | `TreeNode[]` | 살아 있는 페이지 전부를 평평한 목록(`parent_id, position` 순)으로 준다. 트리 만들기·트리 경로(검색 결과)·하위 수(삭제 확인 창)는 화면이 이 목록으로 계산한다 | F-01, F-01.3, F-04 |
| `get_page` | `{ id }` | `Page` | 휴지통 페이지도 읽을 수 있다(휴지통 미리보기용) | F-01 |
| `create_page` | `{ parentId: PageId \| null }` | `Page` | 부모의 맨 끝에 만든다. 제목 `''`, 본문은 빈 문서 `{"type":"doc","content":[{"type":"paragraph"}]}`. 색인 행도 함께 넣는다. 부모가 있으면 `expanded=1`로 바꾼다 | F-01.1 |
| `rename_page` | `{ id, title }` | `{ updatedAt }` | `pages.title`과 `page_fts.title`을 한 트랜잭션에서 고친다. 앞뒤 공백은 잘라 낸다 | F-01.2 |
| `save_page` | `{ id, content: JSONContent }` | `{ updatedAt }` | **한 트랜잭션**에서 `pages.content`·`updated_at`과 `page_fts.body`를 갱신한다(NF-02). 휴지통 페이지면 `NotFound` | F-05 |
| `move_page` | `{ id, newParentId: PageId \| null, newPosition: number }` | `void` | 재귀 CTE로 `newParentId`의 조상 사슬에 `id`가 있으면 `InvalidMove`. 옛 형제와 새 형제의 번호를 다시 매긴다. `newPosition`은 새 형제 수로 잘라 낸다 | F-01.4 |
| `set_expanded` | `{ id, expanded: boolean }` | `void` | | F-01, F-07 |
| `trash_page` | `{ id }` | `{ trashedCount: number }` | 4절 규칙. 하위 포함 개수를 돌려준다 | F-01.3 |
| `list_trash` | 없음 | `TrashItem[]` | `trashed_at DESC` 순. [v2] `path`는 조회 때 재귀 CTE로 부모 사슬을 따라 계산한다(조상이 휴지통에 있어도 제목을 보인다) | F-01.3 |
| `restore_page` | `{ id }` | `{ toRoot: boolean }` | 4절 규칙. 최상위로 갔으면 `toRoot: true`(화면이 알림을 띄울 수 있음) | F-01.3 |
| `delete_page_permanently` | `{ id }` | `void` | 휴지통 묶음 꼭대기만 받는다. 살아 있는 페이지면 `InvalidInput`. 첨부 정리 포함 | F-01.3 |
| `empty_trash` | 없음 | `{ deletedCount: number }` | 휴지통 전체를 한 트랜잭션에서 삭제하고 첨부를 정리한다 | F-01.3 |
| `search` | `{ query: string, limit?: number }` | `SearchHit[]` | 7절. 빈 검색어면 `[]` | F-04 |
| `get_start_page_id` | 없음 | `PageId \| null` | `last_page_id`가 살아 있으면 그 id, 아니면 트리의 첫 페이지(최상위 position 0), 페이지가 없으면 null | F-07 |
| `set_last_page` | `{ id }` | `void` | 페이지를 열 때마다 부른다 | F-07 |
| `save_attachment` | 원본 바이트(raw body) + 헤더 `x-page-id`, `x-ext` | `{ fileName: string }` | 아래 참고. 행을 먼저 넣어 id를 받고, `<id>.<ext>`로 파일을 쓴 뒤 커밋한다. 파일 쓰기에 실패하면 롤백 | F-02.6 |
| `get_data_dir` | 없음 | `string` | 데이터 폴더 절대 경로(설정 화면 표시용) | NF-01 |
| `get_ui_state` [v2] | 없음 | `UiState` | `app_state.ui_state`. 없으면 `{}`(화면이 기본값을 채움) | F-07 |
| `set_ui_state` [v2] | `{ state: UiState }` | `void` | 통째로 바꾼다(부분 갱신 없음). JSON 객체가 아니거나 16KB를 넘으면 `InvalidInput`. 화면은 바뀔 때 디바운스해 부른다 | F-07 |

`save_attachment` 상세:
- 이미지 바이트를 JSON 숫자 배열로 보내면 MB 단위에서 느리다. 그래서 Tauri 2의 raw 요청 본문을 쓴다: `invoke('save_attachment', bytes /* Uint8Array */, { headers: { 'x-page-id': String(id), 'x-ext': 'png' } })`. Rust는 `tauri::ipc::Request`로 받는다. 추가 crate는 없다.
- 허용 확장자: png, jpg, jpeg, gif, webp. 그 밖(svg 포함)은 `UnsupportedType`, 20MB(20×1024×1024바이트) 초과는 `FileTooLarge`, 빈 파일은 `InvalidInput`(카드 2-②, [v2]). 파일 선택은 HTML `<input type="file">`로 한다. dialog 플러그인이 필요 없다.
- [v2] 화면은 보내기 전에 `File.size`·확장자를 먼저 보고 거른다(20MB를 IPC로 보낸 뒤 거부당하지 않게). Rust 검사는 마지막 방어선이다.

저장 순서 규칙(프론트):
- 한 페이지의 `save_page`는 앞의 호출이 끝난 뒤에 보낸다(대기열 1개). 순서가 뒤바뀌어 옛 본문이 새 본문을 덮는 일을 막는다.
- 실패(`Db`·`Io`)하면 편집 내용을 메모리에 두고 5초마다 저절로 다시 보낸다(F-05, 화면 구현 `RETRY_MS`. 개정대기 항목 28).
- [v2] 창 닫기(카드 1-③): 화면이 `onCloseRequested`에서 남은 저장을 기다린다. 실패하거나 3초 안에 끝나지 않으면 닫지 않고 "저장하지 못한 내용이 있습니다 [다시 저장] [그래도 닫기]"를 묻는다. 닫을 때는 화면이 `destroy()`를 부른다(capability `core:window:allow-destroy`, 이번에 추가). Rust 쪽 추가 명령은 없다. 11절 ⑤의 종료 때 WAL 정리만 Rust가 한다.

## 9. 결정 결과 (2026-10-26, 사용자 결정, 카드 20261026-0100-NOTE-pm-p1-db-contract)
1. **창 크기·위치 기억(F-07)**: 결정 = 공식 `tauri-plugin-window-state`(crate + npm 패키지 + capability 추가. 꺼진 모니터 위치 같은 경우를 플러그인이 처리). 직접 구현(창 이벤트에서 `app_state`에 저장, 약 50줄)은 채택하지 않았다.
2. **이미지 표시 방식(F-02.6)**: 결정 = 자체 프로토콜. Rust `register_uri_scheme_protocol`로 `wyasset` 전용 주소를 만든다(Windows에서는 `http://wyasset.localhost/<파일 이름>`). attachments 폴더 안 파일만 내준다. Tauri asset 프로토콜(feature `protocol-asset` + `tauri.conf.json` 범위 설정)은 채택하지 않았다.
3. **본문 JSON 형식(frontend1과 맞춤)**: 결정 = 이미지 노드의 `attrs.src`에는 파일 이름만 둔다(예: `"12.png"`). 화면 쪽 Image 확장이 그릴 때 2번의 주소로 바꾼다. 빈 문서 기본값은 `{"type":"doc","content":[{"type":"paragraph"}]}`이다. frontend1에는 pm이 전달한다.
4. **평문 추출 위치**: 결정 = Rust(6절).
5. **첨부 정리 범위**: 결정 = 영구 삭제 때만 정리한다. 편집 중 지운 이미지 파일은 MVP에서 남겨 둔다(4절).
6. **한 번에 하나만 실행(NF-03)**: 결정 = 공식 `tauri-plugin-single-instance`를 추가하고 P1-1 범위에 넣는다. 두 번째로 실행하면 이미 켜진 창을 앞으로 가져온다.
7. **"폴더 열기"(NF-01)**: [pm 결정] 이미 있는 opener 플러그인을 쓴다. capability에 `opener:allow-open-path`를 더하되 범위는 데이터 폴더(`$APPDATA`)로만 좁힌다(공용 파일). Tauri의 `$APPDATA`가 이미 앱 데이터 폴더 `%APPDATA%\com.wynote.desktop`이다(개정대기 6절).

## 10. 구현 때 만들 파일 (예정)
- `src-tauri/src/db/mod.rs`(연결·PRAGMA·마이그레이션 실행), `db/migrations.rs`, `db/pages.rs`(트리·휴지통), `db/search.rs`(평문 추출·검색), `db/attachments.rs`
- `src-tauri/src/error.rs`(`AppError` 직렬화), `src-tauri/src/commands.rs`(명령 등록), `lib.rs`에서 `setup`·`invoke_handler` 연결
- Rust 단위 테스트: 메모리 DB로 트리 번호 매기기·순환 이동 거부·휴지통 복원 위치·trigram/LIKE 검색·한 트랜잭션 저장(`cargo test`)
- 프론트 타입 `src/lib/db-types.ts`는 프론트 담당과 함께 만든다

## 11. v2 변경 모음 (확정, P3-1)

### 명령·타입 변경 (프론트 계약)
| 구분 | 이름 | 변경 |
|---|---|---|
| 명령 추가 | `get_ui_state` | 없음 → `UiState` |
| 명령 추가 | `set_ui_state` | `{ state: UiState }` → `void` |
| 명령 변경 | `list_trash` | `TrashItem`에 필드 3개 추가(아래) |
| 명령 변경 | `save_attachment` | svg 거부, 20MB 상한, 거부 이유별 kind |
| 타입 추가 | `UiState` | 8절 |
| 타입 변경 | `TrashItem` | `parentId`, `path: string[]`, `restoresToRoot` 추가 |
| 타입 변경 | `AppError.kind` | `FileTooLarge`, `UnsupportedType` + 계약-AI 4.1의 14개 |
| 스키마 | v1 직접 수정 | `pages.id`·`attachments.id`에 `AUTOINCREMENT` |
| 스키마 | v2 추가 | `pages.ai_exclude`, `ai_usage` 표(4.1절) |
| app_state | 키 추가 | `ai_daily_limit`, `api_key_last4`, `ui_state` |
- 계약-AI의 AI 명령(`set_ai_exclude` 등)은 계약-AI.md가 원본이다. 여기서는 표·kind만 맞춘다.
- `src/lib/db-types.ts`는 위 타입대로 프론트가 고친다(확정 뒤 같은 푸시).

### 결정 결과 (카드 20261026-0845-NOTE-pm-db-v2-contract, 모두 아래의 추천안으로 확정)
① **첨부 거부 kind**: 추천 = `FileTooLarge`·`UnsupportedType`를 따로 둔다. 화면이 이유별 문구("20MB를 넘는 이미지는 넣을 수 없습니다" / "이 형식은 넣을 수 없습니다")를 `message`(개발자용) 파싱 없이 고를 수 있다. 대안 = `InvalidInput` 하나에 메시지로 구분(kind 추가 없음, 화면 문구가 하나로 뭉뚱그려짐). → 따로 둔다.
② **이미 만든 v1 개발 DB**: 추천 = 지우고 새로 만든다(실제 노트 없음, 데이터 폴더의 `wy-note.db*`). 대안 = v2 마이그레이션에서 `pages`·`attachments`를 새 표로 옮겨 다시 만든다(FTS rowid·FK를 함께 옮겨야 해서 약 40줄 SQL과 시험이 더 든다). → 지우고 새로 만든다.
③ **`ui_state` 저장 방식**: 추천 = 객체 하나를 통째로 저장하고 Rust는 해석하지 않는다(화면 항목이 늘어도 Rust·계약을 고치지 않음). 대안 = 항목별 키·타입 검사(Rust가 범위를 막지만 항목이 늘 때마다 계약 변경). → 통째로 저장한다.
④ **`TrashItem.restoresToRoot`**: 화면설계 S-04에 "복원하면 최상위로 갑니다"를 보일 근거. → 유지.
⑤ **종료 때 WAL 정리(Rust, 추가 제안)**: 연결은 `tauri::State`에 있어 앱이 끝날 때 drop되지 않을 수 있다. 그러면 정상 종료에도 `wy-note.db-wal`이 남아 3절의 "정상 종료 뒤 폴더 복사 = 백업"이 흐려진다(데이터는 안전, 다음 실행 때 합쳐짐). 추천 = `lib.rs`의 `run`을 `.build()?.run(|app, e| …)`로 바꿔 `RunEvent::Exit`에서 `PRAGMA wal_checkpoint(TRUNCATE)`를 한 번 부른다(약 10줄, 새 명령 없음). → 추가한다.

### 계약 확정과 무관하게 고친 것 (P3-1 2항)
- `capabilities/default.json`: `core:window:allow-destroy` 추가. 화면 `AppShell.tsx`의 닫기 처리 스위치를 켜는 것은 프론트 담당.
- 첨부: svg 제거, 20MB 상한, 거부 이유별 kind(`FileTooLarge`·`UnsupportedType`).
- 디버그 빌드 전용 데이터 폴더 변경: 환경 변수 `WYNOTE_DATA_DIR`(비어 있으면 무시). 릴리스 빌드에는 코드가 컴파일되지 않는다. 바뀌지 않는 것: 창 위치 파일(window-state 플러그인, `%APPDATA%\com.wynote.desktop`), WebView2 데이터(`%LOCALAPPDATA%\com.wynote.desktop`), 한 번에 하나만 실행(식별자 기준이라 실제 앱이 켜져 있으면 시험용 앱이 뜨지 않고 실제 창이 앞으로 온다), "폴더 열기" 범위(`$APPDATA`라 바꾼 폴더는 열리지 않음).
- `tauri.conf.json` 창에 `zoomHotkeysEnabled: true`: Tauri 2 기본값이 false라 지금까지 Ctrl+휠·Ctrl+±·핀치 확대가 꺼져 있었다(WebView2 `IsZoomControlEnabled`). 카드 2-③ "확대는 둔다"에 맞춰 켰다.
- 릴리스 빌드의 개발자 도구: Cargo의 tauri `devtools` feature를 켜지 않아 릴리스에서는 이미 꺼져 있다(F12·Ctrl+Shift+I·"검사" 메뉴 없음). Rust에서 더 할 것 없음.
- F5·Ctrl+R 새로 고침: Rust로 막으려면 WebView2 `AreBrowserAcceleratorKeysEnabled=false`를 써야 하는데 ① Tauri 2.12가 이 설정을 노출하지 않고(wry에만 있음) ② 켜면 Ctrl+±·Ctrl+F 등 브라우저 단축키가 함께 꺼진다. 그래서 화면의 `keydown`에서 릴리스 빌드(`import.meta.env.PROD`)일 때 F5·Ctrl+R·Ctrl+Shift+R·Ctrl+F5를 `preventDefault`하는 것이 맞다 — 프론트 담당.
- `tauri.conf.json` `dangerousDisableAssetCspModification: true`는 그대로 둔다(카드 결정). 끄면 Tauri가 CSP에 nonce를 더해 `style-src 'unsafe-inline'`이 무시되고, TipTap이 실행 중에 넣는 `<style>`과 확장의 `style` 속성이 막힌다.
