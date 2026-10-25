// DB 계약(docs/계약-DB.md 8절)의 TS 타입. Rust 쪽 serde 형식과 같게 유지한다.
// @tiptap/core는 직접 의존성이 아니므로 같은 타입을 다시 내보내는 @tiptap/react에서 가져온다.
import type { JSONContent } from "@tiptap/react";

export type { JSONContent };

export type PageId = number;

export type AppError = {
  kind:
    | "NotFound" // 없는 페이지·첨부, 또는 휴지통 페이지에 편집 명령
    | "InvalidMove" // 자기 자신·하위로 이동, 휴지통 페이지로 이동
    | "InvalidInput" // 잘못된 인자(빈 파일, 지원하지 않는 이미지 형식 등)
    | "Db" // SQLite 오류(디스크 가득 참 등). F-05: 화면이 알리고 다음 저장 때 다시 시도
    | "Io" // 파일 읽기·쓰기 오류(첨부·데이터 폴더)
    | "Migration"; // 시작 때 마이그레이션 실패, 더 새 버전 DB
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
};

export type SearchHit = {
  pageId: PageId;
  title: string;
  snippet: { text: string; match: boolean }[]; // 이어 붙이면 본문 일부. match=true가 강조할 부분
};
