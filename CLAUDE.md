# CLAUDE.md — wy-note

사용자 1명이 이 PC에서만 쓰는 오프라인 우선 블록 노트 데스크탑 앱(D-01~D-04). 모든 역할 세션이 지키는 규칙의 원본이다.

## 먼저 읽을 문서
- `docs/기능정의.md` — 기능(F-xx)·비기능(NF-xx) 요구사항과 완료 기준. 구현의 근거.
- `docs/결정기록.md` — 결정(D-xx). 문서와 다르게 만들어야 하면 구현하지 말고 pm에 [결정 요청].
- `docs/진행현황.md` — 작업 ID·담당·상태·역할별 다음 할 일.
- `docs/아이디어노트.md` — 원래 구상(보관용, 기능정의가 우선).

## 기술 스택
- 앱 셸 Tauri 2 + React 19 + TypeScript + Vite(D-07, D-12). Windows 전용.
- 편집기 TipTap(D-08): 공개 npm의 MIT 패키지만. Pro·Cloud 기능 금지.
- 저장 SQLite 한 파일(D-06). 노트 본문은 TipTap JSON, 검색은 FTS5 trigram(F-04).
- AI는 Claude API(D-05, D-09). API 키는 Windows 자격 증명 관리자에만, 키 접근 코드는 한 모듈에만(NF-05).
- 앱 식별자 `com.wynote.desktop`(D-14) — 데이터 폴더 `%APPDATA%\com.wynote.desktop`(NF-01). 바꾸지 않는다.

## 디렉터리
- `src/` — 프론트엔드(React 화면, TipTap 편집기). 프론트엔드 담당.
- `src-tauri/` — Rust 쪽(Tauri 명령, SQLite, 키 보관, 파일). 백엔드 담당.
- 프론트↔백엔드 경계는 Tauri 명령(`invoke`)이다. 명령 이름·인자·반환 타입을 바꾸면 계약 변경이므로 pm에 먼저 보고한다.
- 공용 파일(`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `capabilities/`)은 의존성·권한을 더하기 전에 pm에 알린다. 새 라이브러리 추가는 사용자 결정 사항이다.

## 명령
- 설치: `npm install` (pnpm 아님)
- 개발 실행: `npm run tauri dev` (첫 빌드 약 1분 30초)
- 타입 검사 + 프론트 빌드: `npm run build`
- Rust 검사: `src-tauri`에서 `cargo check` (cargo가 PATH에 없으면 `%USERPROFILE%\.cargo\bin`(bash는 `$HOME/.cargo/bin`)을 PATH 앞에 붙인다)
- 릴리스 빌드: `npm run tauri build` (약 1분 30초~3분, 설치 파일은 `src-tauri/target/release/bundle/`)
- 검사 스크립트(프로젝트 루트): `node scripts/check-markdown.ts`(마크다운 변환), `node scripts/check-ai.ts`(AI 화면 로직). Rust는 `src-tauri`에서 `cargo test -j 2`
- lint 설정은 아직 없다. 생기면 여기에 적는다.

## 지켜야 할 것
- 오프라인 완결(NF-06): AI 호출 말고는 네트워크 요청 금지. 원격 글꼴·CDN·분석 도구·업데이트 확인 금지. 글꼴·아이콘은 앱에 포함한다.
- 노트 내용은 AI 호출 말고는 PC 밖으로 나가지 않는다(NF-01).
- 메모리 목표(NF-04, D-13): 유휴 상태 앱 + WebView2 Private 합계 300MB 이하. 무거운 의존성을 넣을 때 의식한다.
- 비밀값(API 키·토큰·비밀번호·개인 주소)은 소스·문서·커밋 메시지·로그에 적지 않는다. `.env*`는 무시 대상이다.

## 작업 방식
- 메모리가 작은 PC(RAM 16GB, 세션 여러 개가 함께 돈다). 빌드·`tauri dev`·브라우저 자동화 전에 여유 메모리를 확인한다(PowerShell `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`). 500MB 미만이면 시작하지 말고 pm에 알린다. 끝나면 dev 서버·앱·webview 프로세스를 닫는다.
- 역할 세션은 각자 `.claude/worktrees/<역할>`(가지 `wt/<역할>`)에서 일한다. 본 저장소에서는 `git stash`·`checkout`·`restore`·`reset`·`clean` 금지.
- 커밋·푸시·병합은 `NOTE-commit`만 한다. 커밋 요청에는 가지·파일 목록·메시지를 적고, 요청한 파일은 완료 회신 전까지 고치지 않는다.
- 보고는 pm(`NOTE-pm`)에 `[완료]`·`[결정 요청]`·`[차단]`·`[결함]`으로 보낸다. `[완료]`에는 실제로 돌린 검증 명령과 결과를 적는다.
- 백그라운드 세션의 권한 요청 창은 아무도 승인하지 못한다. 권한이 필요한 동작은 하지 말고 `[차단]`으로 보고한다.
