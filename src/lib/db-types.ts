// DB 계약(docs/계약-DB.md 8절, v2)의 TS 타입. Rust 쪽 serde 형식과 같게 유지한다.
// @tiptap/core는 직접 의존성이 아니므로 같은 타입을 다시 내보내는 @tiptap/react에서 가져온다.
import type { JSONContent } from "@tiptap/react";

export type { JSONContent };

export type PageId = number;

/** 계약-AI 4.1의 AI 오류 14개. */
export type AiErrorKind =
  | "NoApiKey"
  | "Keyring"
  | "Offline"
  | "AiTimeout"
  | "AiAuth"
  | "AiCredit"
  | "AiRateLimit"
  | "AiOverloaded"
  | "AiApi"
  | "AiExcluded"
  | "AiDailyLimit"
  | "InputTooLong"
  | "AiBusy"
  | "Cancelled";

export type AppError = {
  kind:
    | "NotFound" // 없는 페이지·첨부, 또는 휴지통 페이지에 편집 명령
    | "InvalidMove" // 자기 자신·하위로 이동, 휴지통 페이지로 이동
    | "InvalidInput" // 잘못된 인자(빈 파일 등)
    | "Db" // SQLite 오류(디스크 가득 참 등). F-05: 화면이 알리고 다음 저장 때 다시 시도
    | "DbBusy" // 다른 프로그램이 DB 파일을 잠가 쓰지 못함(백업·동기화 등). Db처럼 다시 시도
    | "Io" // 파일 읽기·쓰기 오류(첨부·데이터 폴더)
    | "Migration" // 시작 때 마이그레이션 실패, 더 새 버전 DB
    | "FileTooLarge" // 첨부가 20MB 초과
    | "UnsupportedType" // 허용 밖 이미지 형식(svg·bmp·ico·heic 등)
    | AiErrorKind;
  message: string; // 개발자용 설명(한국어). 노트 본문은 넣지 않는다
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
  content: JSONContent;
  createdAt: number;
  updatedAt: number;
};

export type TrashItem = {
  id: PageId; // 묶음의 꼭대기
  title: string;
  trashedAt: number;
  descendantCount: number;
  parentId: PageId | null; // 원래 부모. 최상위였거나 부모가 영구 삭제됐으면 null
  path: string[]; // 원래 위치: 최상위부터 부모까지 제목. [] = 최상위. '' 제목은 화면이 "제목 없음"으로
  restoresToRoot: boolean; // 지금 복원하면 최상위로 가는가(부모가 null이거나 아직 휴지통)
};

/** 화면 상태(F-07 확장). Rust는 내용을 해석하지 않고 그대로 저장한다. 빠진 키는 기본값. */
export type UiState = {
  theme?: "system" | "light" | "dark";
  sidebarWidth?: number; // 200~360
  sidebarCollapsed?: boolean;
  aiPanelOpen?: boolean;
  aiPanelWidth?: number; // 300~480
  recentPageIds?: PageId[]; // 최근 연 페이지(최신 먼저, 최대 5). 지운 페이지 거르기는 화면이
};

export type SearchHit = {
  pageId: PageId;
  title: string;
  snippet: { text: string; match: boolean }[]; // 이어 붙이면 본문 일부. match=true가 강조할 부분
};
