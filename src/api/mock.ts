// 브라우저 개발용 가짜 백엔드. 계약 4절·8절 규칙을 메모리에서 흉내 내고, 새로고침해도 남게 localStorage에 둔다.
// Tauri 안에서는 쓰지 않는다. 검색은 단순 포함 검사만 한다(trigram·LIKE 구분 없음).
import { EMPTY_DOC } from "../editor/Editor";
import { isAttachmentName } from "../export/exportTree";
import type { AppError, JSONContent, Page, PageId, TreeNode, UiState } from "../lib/db-types";
import { ancestors, indexTree } from "../tree/tree";
import type { Backend } from "./index";

type Row = {
  id: PageId;
  parentId: PageId | null;
  position: number;
  title: string;
  content: JSONContent;
  expanded: boolean;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  trashRootId: PageId | null;
};

type Db = { nextId: number; rows: Row[]; lastPageId: PageId | null; uiState?: UiState };

const KEY = "wy-note-mock-db";

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    // 저장소를 못 쓰면 메모리로만 돈다.
  }
  return { nextId: 1, rows: [], lastPageId: null };
}

function fail(kind: AppError["kind"], message: string): never {
  throw { kind, message } satisfies AppError;
}

export function createMockBackend(): Backend {
  const db = load();
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch {
      // 위와 같다.
    }
  };
  const alive = (r: Row) => r.trashedAt === null;
  const get = (id: PageId) => db.rows.find((r) => r.id === id) ?? fail("NotFound", `페이지 ${id} 없음`);
  const getAlive = (id: PageId) => {
    const r = get(id);
    return alive(r) ? r : fail("NotFound", `페이지 ${id}는 휴지통에 있음`);
  };
  const siblings = (parentId: PageId | null) =>
    db.rows.filter((r) => alive(r) && r.parentId === parentId).sort((a, b) => a.position - b.position);
  const renumber = (list: Row[]) => list.forEach((r, i) => (r.position = i));
  const aliveSubtree = (id: PageId): Row[] => {
    const out: Row[] = [];
    const walk = (pid: PageId) =>
      db.rows.filter((r) => alive(r) && r.parentId === pid).forEach((r) => (out.push(r), walk(r.id)));
    walk(id);
    return out;
  };
  const toTree = (r: Row): TreeNode => ({
    id: r.id,
    parentId: r.parentId,
    position: r.position,
    title: r.title,
    expanded: r.expanded,
  });
  const toPage = (r: Row): Page => ({
    id: r.id,
    parentId: r.parentId,
    title: r.title,
    content: structuredClone(r.content),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  const removeBundle = (rootId: PageId) => {
    const ids = new Set(db.rows.filter((r) => r.trashRootId === rootId).map((r) => r.id));
    db.rows = db.rows.filter((r) => !ids.has(r.id));
    // FK ON DELETE SET NULL
    db.rows.forEach((r) => {
      if (r.parentId !== null && ids.has(r.parentId)) r.parentId = null;
    });
    return ids.size;
  };

  // 실제 명령처럼 비동기로 돌되, 본문은 부른 순간 동기적으로 반영한다(창 닫기 직전 저장이 남게).
  // 읽기 명령(read)은 저장소에 다시 쓰지 않는다.
  const run = <T>(fn: () => T, write = true): Promise<T> => {
    try {
      const v = fn();
      if (write) persist();
      return Promise.resolve(v);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const read = <T>(fn: () => T) => run(fn, false);

  return {
    listTree: () =>
      read(() =>
        db.rows
          .filter(alive)
          .sort((a, b) => (a.parentId ?? 0) - (b.parentId ?? 0) || a.position - b.position)
          .map(toTree),
      ),
    getPage: (id) => read(() => toPage(get(id))),
    createPage: (parentId) =>
      run(() => {
        if (parentId !== null) getAlive(parentId).expanded = true;
        const now = Date.now();
        const row: Row = {
          id: db.nextId++,
          parentId,
          position: -1,
          title: "",
          content: EMPTY_DOC,
          expanded: false,
          createdAt: now,
          updatedAt: now,
          trashedAt: null,
          trashRootId: null,
        };
        db.rows.push(row);
        // 새 페이지는 부모의 맨 앞(P5-3). 기존 형제는 한 칸씩 밀린다.
        renumber(siblings(parentId));
        return toPage(row);
      }),
    renamePage: (id, title) =>
      run(() => {
        const r = getAlive(id);
        r.title = title.trim();
        r.updatedAt = Date.now();
        return { updatedAt: r.updatedAt };
      }),
    savePage: (id, content) =>
      run(() => {
        const r = getAlive(id);
        r.content = structuredClone(content);
        r.updatedAt = Date.now();
        return { updatedAt: r.updatedAt };
      }),
    movePage: (id, newParentId, newPosition) =>
      run(() => {
        const r = getAlive(id);
        if (newParentId !== null) {
          getAlive(newParentId);
          if (newParentId === id || aliveSubtree(id).some((d) => d.id === newParentId))
            fail("InvalidMove", "자기 자신이나 하위로는 옮길 수 없음");
        }
        const oldParent = r.parentId;
        const target = siblings(newParentId).filter((s) => s.id !== id);
        target.splice(Math.max(0, Math.min(newPosition, target.length)), 0, r);
        r.parentId = newParentId;
        renumber(target);
        if (oldParent !== newParentId) renumber(siblings(oldParent));
      }),
    setExpanded: (id, expanded) =>
      run(() => {
        getAlive(id).expanded = expanded;
      }),
    trashPage: (id) =>
      run(() => {
        const r = getAlive(id);
        const bundle = [r, ...aliveSubtree(id)];
        const now = Date.now();
        bundle.forEach((b) => ((b.trashedAt = now), (b.trashRootId = id)));
        renumber(siblings(r.parentId));
        if (db.lastPageId !== null && bundle.some((b) => b.id === db.lastPageId)) db.lastPageId = null;
        return { trashedCount: bundle.length };
      }),
    listTrash: () =>
      read(() => {
        const ix = indexTree(db.rows.map(toTree));
        return db.rows
          .filter((r) => r.trashedAt !== null && r.trashRootId === r.id)
          .sort((a, b) => b.trashedAt! - a.trashedAt!)
          .map((r) => ({
            id: r.id,
            title: r.title,
            trashedAt: r.trashedAt!,
            descendantCount: db.rows.filter((x) => x.trashRootId === r.id).length - 1,
            parentId: r.parentId,
            // 원래 위치: 최상위부터 부모까지 제목(휴지통에 있는 조상도 포함).
            path: ancestors(ix, r.id).map((n) => n.title),
            restoresToRoot: r.parentId === null || !alive(get(r.parentId)),
          }));
      }),
    restorePage: (id) =>
      run(() => {
        const top = get(id);
        if (top.trashRootId !== id) fail("InvalidInput", "휴지통 묶음 꼭대기가 아님");
        const parent = top.parentId === null ? null : db.rows.find((r) => r.id === top.parentId);
        // 원래 최상위였으면 toRoot는 false다(원래 부모가 없어져 최상위로 갔을 때만 true).
        const toRoot = top.parentId !== null && (!parent || !alive(parent));
        const oldPosition = top.position;
        db.rows.filter((r) => r.trashRootId === id).forEach((r) => ((r.trashedAt = null), (r.trashRootId = null)));
        if (toRoot) top.parentId = null;
        const list = siblings(top.parentId).filter((s) => s.id !== id);
        list.splice(toRoot ? list.length : Math.min(oldPosition, list.length), 0, top);
        renumber(list);
        return { toRoot };
      }),
    deletePagePermanently: (id) =>
      run(() => {
        const r = get(id);
        if (r.trashRootId !== id) fail("InvalidInput", "휴지통 묶음 꼭대기만 영구 삭제할 수 있음");
        removeBundle(id);
      }),
    emptyTrash: () =>
      run(() => {
        const roots = db.rows.filter((r) => r.trashedAt !== null && r.trashRootId === r.id).map((r) => r.id);
        return { deletedCount: roots.reduce((n, rid) => n + removeBundle(rid), 0) };
      }),
    search: (query, limit = 50) =>
      read(() => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        return db.rows
          .filter(alive)
          .map((r) => ({ r, text: plainText(r.content) }))
          .filter(({ r, text }) => words.every((w) => `${r.title}\n${text}`.toLowerCase().includes(w)))
          .slice(0, Math.max(1, Math.min(500, limit)))
          .map(({ r, text }) => ({ pageId: r.id, title: r.title, snippet: snippet(text, words[0]) }));
      }),
    getStartPageId: () =>
      read(() => {
        const last = db.lastPageId === null ? undefined : db.rows.find((r) => r.id === db.lastPageId);
        if (last && alive(last)) return last.id;
        return siblings(null)[0]?.id ?? null;
      }),
    setLastPage: (id) =>
      run(() => {
        getAlive(id);
        db.lastPageId = id;
      }),
    saveAttachment: (_pageId, ext, bytes) =>
      run(() => {
        if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) fail("UnsupportedType", `확장자 ${ext}`);
        if (bytes.length === 0) fail("InvalidInput", "빈 파일");
        if (bytes.length > 20 * 1024 * 1024) fail("FileTooLarge", `${bytes.length}바이트`);
        return { fileName: `mock-${Date.now()}.${ext}` };
      }),
    getDataDir: () => read(() => "(브라우저 mock: localStorage)"),
    getUiState: () => read(() => structuredClone(db.uiState ?? {})),
    setUiState: (state) =>
      run(() => {
        if (JSON.stringify(state).length > 16 * 1024) fail("InvalidInput", "화면 상태가 16KB를 넘음");
        db.uiState = structuredClone(state);
      }),
    // 파일은 쓰지 않는다. localStorage "wy-note-mock-export"를 cancel·fail로 두면 취소·실패를 흉내 낸다.
    exportMarkdown: ({ root, attachments }) =>
      new Promise((resolve, reject) =>
        setTimeout(() => {
          let mode: string | null = null;
          try {
            mode = localStorage.getItem("wy-note-mock-export");
          } catch {
            // 위와 같다.
          }
          if (mode === "cancel") return resolve({ cancelled: true });
          if (mode === "fail") return reject({ kind: "Io", message: "mock 쓰기 실패" } satisfies AppError);
          if (!attachments.every(isAttachmentName)) return reject({ kind: "InvalidInput", message: "첨부 이름" } satisfies AppError);
          const count = (n: typeof root): number => 1 + n.children.reduce((s, c) => s + count(c), 0);
          // mock 첨부는 실제 파일이 없으므로 모두 "찾지 못함"으로 돌려준다.
          resolve({
            cancelled: false,
            dir: `C:\\Users\\mock\\Documents\\${root.title.trim() || "제목 없음"}`,
            fileCount: count(root),
            imageCount: 0,
            missingImages: attachments,
          });
        }, 600),
      ),
  };
}

function plainText(node: JSONContent): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(plainText).join(node.type === "doc" ? "\n" : "");
}

function snippet(text: string, word: string) {
  const i = text.toLowerCase().indexOf(word);
  if (i < 0) return [{ text: text.slice(0, 60), match: false }];
  const start = Math.max(0, i - 30);
  return [
    { text: text.slice(start, i), match: false },
    { text: text.slice(i, i + word.length), match: true },
    { text: text.slice(i + word.length, i + word.length + 30), match: false },
  ];
}
