// Tauri 명령(docs/계약-DB.md 8절)을 감싼 타입 있는 클라이언트. 화면은 invoke를 직접 부르지 않고 이것만 쓴다.
// Tauri 밖(브라우저 개발)에서는 메모리 가짜 구현(mock.ts)으로 바뀐다. 실패하면 AppError로 reject한다.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ExportRequest, ExportResult } from "../export/exportTree";
import type { AppError, JSONContent, Page, PageId, SearchHit, TrashItem, TreeNode, UiState } from "../lib/db-types";

export type Backend = {
  listTree(): Promise<TreeNode[]>;
  getPage(id: PageId): Promise<Page>;
  createPage(parentId: PageId | null): Promise<Page>;
  renamePage(id: PageId, title: string): Promise<{ updatedAt: number }>;
  savePage(id: PageId, content: JSONContent): Promise<{ updatedAt: number }>;
  /** newPosition은 옮긴 뒤 새 형제 목록에서의 순서(0부터). 형제 수보다 크면 맨 끝. */
  movePage(id: PageId, newParentId: PageId | null, newPosition: number): Promise<void>;
  setExpanded(id: PageId, expanded: boolean): Promise<void>;
  trashPage(id: PageId): Promise<{ trashedCount: number }>;
  listTrash(): Promise<TrashItem[]>;
  restorePage(id: PageId): Promise<{ toRoot: boolean }>;
  deletePagePermanently(id: PageId): Promise<void>;
  emptyTrash(): Promise<{ deletedCount: number }>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  getStartPageId(): Promise<PageId | null>;
  setLastPage(id: PageId): Promise<void>;
  /** ext: png, jpg, jpeg, gif, webp. 그 밖은 UnsupportedType, 20MB 초과는 FileTooLarge. */
  saveAttachment(pageId: PageId, ext: string, bytes: Uint8Array): Promise<{ fileName: string }>;
  getDataDir(): Promise<string>;
  /** 저장한 적이 없으면 {}. */
  getUiState(): Promise<UiState>;
  /** 통째로 바꾼다(16KB 넘으면 InvalidInput). */
  setUiState(state: UiState): Promise<void>;
  /** F-06(docs/계약-AI.md 5.3). Rust가 폴더 선택 창을 띄운다. 고르지 않으면 { cancelled: true }. */
  exportMarkdown(req: ExportRequest): Promise<ExportResult>;
};

const tauriBackend: Backend = {
  listTree: () => invoke("list_tree"),
  getPage: (id) => invoke("get_page", { id }),
  createPage: (parentId) => invoke("create_page", { parentId }),
  renamePage: (id, title) => invoke("rename_page", { id, title }),
  savePage: (id, content) => invoke("save_page", { id, content }),
  movePage: (id, newParentId, newPosition) => invoke("move_page", { id, newParentId, newPosition }),
  setExpanded: (id, expanded) => invoke("set_expanded", { id, expanded }),
  trashPage: (id) => invoke("trash_page", { id }),
  listTrash: () => invoke("list_trash"),
  restorePage: (id) => invoke("restore_page", { id }),
  deletePagePermanently: (id) => invoke("delete_page_permanently", { id }),
  emptyTrash: () => invoke("empty_trash"),
  search: (query, limit) => invoke("search", limit === undefined ? { query } : { query, limit }),
  getStartPageId: () => invoke("get_start_page_id"),
  setLastPage: (id) => invoke("set_last_page", { id }),
  // 바이트를 JSON 숫자 배열로 보내지 않고 raw 본문으로 보낸다(계약 8절 save_attachment 상세).
  saveAttachment: (pageId, ext, bytes) =>
    invoke("save_attachment", bytes, { headers: { "x-page-id": String(pageId), "x-ext": ext } }),
  getDataDir: () => invoke("get_data_dir"),
  getUiState: () => invoke("get_ui_state"),
  setUiState: (state) => invoke("set_ui_state", { state }),
  exportMarkdown: (req) => invoke("export_markdown", req),
};

let backend: Backend | null = null;

/** 앱을 그리기 전에 한 번 기다린다. 그 뒤 api 호출은 곧바로 백엔드로 간다(창 닫기 직전 저장이 늦지 않게). */
export async function initApi(): Promise<void> {
  if (backend) return;
  // mock은 Tauri 빌드에서도 별도 조각으로만 남고, Tauri 안에서는 불러오지 않는다.
  backend = isTauri() ? tauriBackend : (await import("./mock")).createMockBackend();
}

function current(): Backend {
  if (!backend) throw new Error("initApi()를 먼저 기다려야 합니다");
  return backend;
}

export const api: Backend = new Proxy({} as Backend, {
  get: (_t, name) => current()[name as keyof Backend],
});

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** 화면에 띄울 짧은 이유. 개발자용 message는 보이지 않는다. */
export function errorReason(e: unknown): string {
  if (!isAppError(e)) return "알 수 없는 오류가 났습니다";
  switch (e.kind) {
    case "NotFound":
      return "페이지를 찾을 수 없습니다";
    case "InvalidMove":
      return "그 위치로는 옮길 수 없습니다";
    case "InvalidInput":
      return "잘못된 입력입니다";
    case "Db":
      return "데이터베이스에 쓰지 못했습니다(디스크 공간을 확인하세요)";
    case "Io":
      return "파일을 읽거나 쓰지 못했습니다";
    case "Migration":
      return "데이터 파일을 열지 못했습니다";
    case "FileTooLarge":
      return "20MB가 넘는 파일은 넣을 수 없습니다";
    case "UnsupportedType":
      return "PNG·JPG·GIF·WebP 이미지만 넣을 수 있습니다";
    default:
      return "알 수 없는 오류가 났습니다";
  }
}
