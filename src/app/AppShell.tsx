// 앱 셸(화면설계 S-01): 사이드바 · 편집 영역 · AI 패널 자리. 트리(S-02), 빈 상태(S-09), 저장 실패(S-10)를 묶는다.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorReason } from "../api";
import type { JSONContent, Page, PageId, TreeNode } from "../lib/db-types";
import { PageTree, type PageTreeHandle } from "../tree/PageTree";
import { ancestors, descendantIds, displayTitle, indexTree } from "../tree/tree";
import { Autosaver, type SaveStatus } from "./autosave";
import { ConfirmDialog } from "./ConfirmDialog";
import { PageView } from "./PageView";
import { Toast, type ToastData } from "./Toast";
import "./AppShell.css";

type View = "page" | "trash";

const LAYOUT_KEY = "wy-note-layout";

/** core:window:allow-destroy 권한이 들어오면 true로 바꾼다. */
const CLOSE_SAVE_ENABLED = false;
const CLOSE_SAVE_TIMEOUT_MS = 3000;

function loadLayout(): { sidebar: boolean; ai: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (v && typeof v.sidebar === "boolean" && typeof v.ai === "boolean") return v;
  } catch {
    // 저장소를 못 쓰면 기본값.
  }
  return { sidebar: true, ai: false };
}

export function AppShell() {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [openId, setOpenId] = useState<PageId | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const [view, setView] = useState<View>("page");
  const [layout, setLayout] = useState(loadLayout);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: "saved" });
  const [confirmTrash, setConfirmTrash] = useState<{ id: PageId; count: number } | null>(null);
  const [toast, setToastState] = useState<(ToastData & { id: number }) | null>(null);
  // 같은 문구가 다시 와도 5초를 새로 센다.
  const setToast = (t: ToastData) => setToastState({ ...t, id: Date.now() });
  const [loadError, setLoadError] = useState<string | null>(null);

  const ix = useMemo(() => indexTree(nodes ?? []), [nodes]);
  const ixRef = useRef(ix);
  ixRef.current = ix;
  const treeRef = useRef<PageTreeHandle>(null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const openSeq = useRef(0);

  const [saver] = useState(
    () =>
      new Autosaver((id, status) => {
        if (id === openIdRef.current) setSaveStatus(status);
      }),
  );

  const reloadTree = useCallback(async () => {
    // 아직 보내지 않은 이름이 있으면 먼저 저장한다(아니면 DB의 옛 이름이 트리를 덮는다).
    await saver.flushAll();
    const list = await api.listTree();
    setNodes(list);
    return indexTree(list);
  }, [saver]);

  const showError = (e: unknown) => setToast({ message: errorReason(e) });

  const patchNodes = (ids: PageId[], patch: Partial<TreeNode>) =>
    setNodes((list) => list && list.map((n) => (ids.includes(n.id) ? { ...n, ...patch } : n)));

  /** 페이지를 연다. 앞 페이지의 남은 저장을 먼저 보낸다(F-05). */
  const openPage = useCallback(
    async (id: PageId, opts: { created?: Page; treeIndex?: ReturnType<typeof indexTree> } = {}) => {
      const seq = ++openSeq.current;
      setView("page");
      const prev = openIdRef.current;
      // 열 페이지의 저장이 진행 중이면 그것도 끝난 뒤에 읽는다(DB의 옛 본문을 열지 않게).
      await Promise.all([saver.flush(id), prev !== null && prev !== id ? saver.flush(prev) : null]);
      try {
        const loaded = opts.created ?? (await api.getPage(id));
        if (seq !== openSeq.current) return;
        const pending = saver.pendingContent(id);
        setPage(pending ? { ...loaded, content: pending } : loaded);
        setOpenId(id);
        openIdRef.current = id;
        setSaveStatus(saver.status(id));
        setFocusTitle(!!opts.created);
        void api.setLastPage(id).catch(() => {});
        // 열린 페이지의 접힌 조상은 펼친다(S-02).
        const tix = opts.treeIndex ?? ixRef.current;
        const closed = ancestors(tix, id).filter((n) => !n.expanded);
        if (closed.length) {
          patchNodes(closed.map((n) => n.id), { expanded: true });
          closed.forEach((n) => void api.setExpanded(n.id, true).catch(() => {}));
        }
      } catch (e) {
        if (seq === openSeq.current) showError(e);
      }
    },
    [saver],
  );

  // 시작: 트리와 시작 페이지(F-07).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tix, start] = await Promise.all([reloadTree(), api.getStartPageId()]);
        if (alive && start !== null) await openPage(start, { treeIndex: tix });
      } catch (e) {
        if (alive) setLoadError(errorReason(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadTree, openPage]);

  // 새로고침·창 닫기 직전 남은 저장을 보낸다. 저장 호출은 동기적으로 시작된다(autosave.ts).
  useEffect(() => {
    const onUnload = () => void saver.flushAll();
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [saver]);

  // 창 닫기(X·Alt+F4): 남은 저장이 끝난 뒤 닫는다. onCloseRequested는 핸들러를 기다린 뒤 스스로 destroy()를 부른다.
  // destroy에는 capabilities의 core:window:allow-destroy가 필요하다. 권한이 들어오기 전에는 창이 닫히지 않으므로 꺼 둔다.
  useEffect(() => {
    if (!CLOSE_SAVE_ENABLED || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(() =>
        // 저장이 멈춰도 창은 닫히게 상한을 둔다.
        Promise.race([saver.flushAll(), new Promise<void>((r) => setTimeout(r, CLOSE_SAVE_TIMEOUT_MS))]),
      )
      .then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [saver]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // 위와 같다.
    }
  }, [layout]);

  const createPage = useCallback(
    async (parentId: PageId | null) => {
      try {
        const created = await api.createPage(parentId);
        const tix = await reloadTree();
        await openPage(created.id, { created, treeIndex: tix });
      } catch (e) {
        showError(e);
      }
    },
    [reloadTree, openPage],
  );

  const renamePage = (id: PageId, title: string) => {
    patchNodes([id], { title });
    saver.setTitle(id, title);
  };

  const toggle = (id: PageId, expanded: boolean) => {
    patchNodes([id], { expanded });
    api.setExpanded(id, expanded).catch((e) => {
      showError(e);
      void reloadTree();
    });
  };

  const move = async (id: PageId, newParentId: PageId | null, newPosition: number) => {
    try {
      await api.movePage(id, newParentId, newPosition);
      // 접힌 페이지 안으로 놓았으면 펼쳐서 옮긴 페이지가 보이게 한다.
      const parent = newParentId === null ? undefined : ix.byId.get(newParentId);
      if (parent && !parent.expanded) await api.setExpanded(parent.id, true);
    } catch (e) {
      showError(e);
    }
    await reloadTree();
  };

  const requestTrash = (id: PageId) => setConfirmTrash({ id, count: descendantIds(ix, id).length });

  const doTrash = async (id: PageId) => {
    setConfirmTrash(null);
    const bundle = [id, ...descendantIds(ix, id)];
    // 휴지통에서 되살렸을 때 마지막 입력까지 남도록 먼저 저장한다.
    await Promise.all(bundle.map((b) => saver.flush(b)));
    // 저장하지 못한 내용이 있으면 옮기지 않는다(옮기면 그 내용을 다시 저장할 곳이 없다).
    const failed = bundle.map((b) => saver.status(b)).find((s) => s.state === "error");
    if (failed?.state === "error") {
      setToast({ message: `저장하지 못한 내용이 있어 휴지통으로 옮기지 않았습니다. ${errorReason(failed.error)}` });
      return;
    }
    saver.discard(bundle);
    const node = ix.byId.get(id)!;
    const sibs = ix.children.get(node.parentId) ?? [];
    const above = sibs[sibs.findIndex((s) => s.id === id) - 1];
    try {
      await api.trashPage(id);
    } catch (e) {
      showError(e);
      return;
    }
    const tix = await reloadTree();
    const current = openIdRef.current;
    if (current !== null && bundle.includes(current)) {
      // 바로 위 형제 → 부모 → 첫 페이지(S-03).
      const next = above?.id ?? node.parentId ?? tix.children.get(null)?.[0]?.id ?? null;
      if (next !== null) await openPage(next, { treeIndex: tix });
      else {
        setPage(null);
        setOpenId(null);
        openIdRef.current = null;
      }
    }
    setToast({
      message: `"${displayTitle(node.title)}"을 휴지통으로 옮겼습니다`,
      action: {
        label: "실행 취소",
        run: async () => {
          try {
            await api.restorePage(id);
            await reloadTree();
          } catch (e) {
            showError(e);
          }
        },
      },
    });
  };

  // 전역 단축키(S-01). 검색 Ctrl+K·설정 Ctrl+,은 해당 화면이 붙을 때 더한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      // e.key는 한글 입력 상태에서 자모가 될 수 있어 키 위치(e.code)로 본다.
      if (e.code === "KeyN") void createPage(null);
      else if (e.code === "Backslash") setLayout((l) => ({ ...l, sidebar: !l.sidebar }));
      else if (e.code === "KeyJ") setLayout((l) => ({ ...l, ai: !l.ai }));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createPage]);

  const openNode = openId !== null ? ix.byId.get(openId) : undefined;
  const path = openId !== null ? ancestors(ix, openId) : [];
  // 깊은 경로는 맨 위 하나와 가까운 둘만 보이고 가운데는 "…"로 줄인다.
  const crumbs = path.length > 3 ? [path[0], null, ...path.slice(-2)] : path;
  const hiddenCrumbs = path.length > 3 ? path.slice(1, -2).map((n) => displayTitle(n.title)).join(" / ") : "";
  const empty = nodes !== null && nodes.length === 0;

  return (
    <div className="shell" data-sidebar={layout.sidebar ? "open" : "closed"} data-ai={layout.ai ? "open" : "closed"}>
      {layout.sidebar && (
        <nav className="sidebar" aria-label="사이드바">
          <div className="sidebar-head">
            <span className="sidebar-brand">wy-note</span>
            <button
              type="button"
              className="icon-button"
              aria-label="사이드바 접기"
              aria-keyshortcuts="Control+\"
              title="사이드바 접기 (Ctrl+\)"
              onClick={() => setLayout((l) => ({ ...l, sidebar: false }))}
            >
              ◧
            </button>
          </div>
          {/* S-05 검색 진입(NOTE-frontend3 컴포넌트) 자리 */}
          <button
            type="button"
            className="sidebar-new"
            aria-keyshortcuts="Control+N"
            title="새 페이지 (Ctrl+N)"
            onClick={() => void createPage(null)}
          >
            + 새 페이지
          </button>
          <div className="sidebar-label" id="tree-label">
            페이지
          </div>
          <div className="sidebar-tree">
            {nodes === null ? null : (
              <PageTree
                ref={treeRef}
                ix={ix}
                selectedId={view === "page" ? openId : null}
                onOpen={(id) => void openPage(id)}
                onCreate={(pid) => void createPage(pid)}
                onRename={renamePage}
                onToggle={toggle}
                onTrash={requestTrash}
                onMove={(id, p, pos) => void move(id, p, pos)}
              />
            )}
          </div>
          <div className="sidebar-foot">
            <button
              type="button"
              className="sidebar-link"
              aria-current={view === "trash" ? "page" : undefined}
              onClick={() => {
                if (openId !== null) void saver.flush(openId);
                setView("trash");
              }}
            >
              휴지통
            </button>
            {/* S-08 설정 진입 자리 */}
          </div>
        </nav>
      )}

      <main className="main">
        <header className="topbar">
          {!layout.sidebar && (
            <button
              type="button"
              className="icon-button"
              aria-label="사이드바 펴기"
              aria-keyshortcuts="Control+\"
              title="사이드바 펴기 (Ctrl+\)"
              onClick={() => setLayout((l) => ({ ...l, sidebar: true }))}
            >
              ◧
            </button>
          )}
          {view === "page" && openNode && (
            <>
              <ol className="breadcrumb" aria-label="경로">
                {crumbs.map((n) =>
                  n === null ? (
                    <li key="more" title={hiddenCrumbs} aria-label={`생략된 경로: ${hiddenCrumbs}`}>
                      …
                    </li>
                  ) : (
                    <li key={n.id}>
                      <button type="button" className="breadcrumb-link" onClick={() => void openPage(n.id)}>
                        {displayTitle(n.title)}
                      </button>
                    </li>
                  ),
                )}
                <li aria-current="page">{displayTitle(openNode.title)}</li>
              </ol>
              <SaveIndicator status={saveStatus} />
            </>
          )}
          <button
            type="button"
            className="topbar-ai"
            aria-pressed={layout.ai}
            aria-keyshortcuts="Control+J"
            title="AI 패널 (Ctrl+J)"
            onClick={() => setLayout((l) => ({ ...l, ai: !l.ai }))}
          >
            AI
          </button>
        </header>

        {view === "page" && openId !== null && saveStatus.state === "error" && (
          <div className="save-error" role="alert">
            <span>
              저장하지 못했습니다. {errorReason(saveStatus.error)}. 편집 내용은 그대로 있고 5초마다 다시 저장합니다.
            </span>
            <button
              type="button"
              className="button"
              onClick={async (e) => {
                const btn = e.currentTarget;
                await saver.flush(openId);
                // 저장되면 이 띠가 사라진다: 포커스를 본문으로 돌려 놓는다.
                if (!btn.isConnected) document.querySelector<HTMLElement>(".editor-body")?.focus();
              }}
            >
              지금 다시 저장
            </button>
          </div>
        )}

        <div className="content">
          {loadError ? (
            <div className="content-message" role="alert">
              <p>데이터를 불러오지 못했습니다. {loadError}.</p>
              <button type="button" className="button" onClick={() => window.location.reload()}>
                다시 불러오기
              </button>
            </div>
          ) : view === "trash" ? (
            // S-04 휴지통(NOTE-frontend3 컴포넌트) 자리
            <section className="content-slot" aria-label="휴지통" />
          ) : empty ? (
            <EmptyState onCreate={() => void createPage(null)} />
          ) : page && openNode ? (
            <PageView
              key={page.id}
              page={page}
              title={openNode.title}
              focusTitle={focusTitle}
              onTitleChange={(t) => renamePage(page.id, t)}
              onContentChange={(doc: JSONContent) => saver.setContent(page.id, doc)}
            />
          ) : null}
        </div>
      </main>

      {layout.ai && (
        // S-07 AI 패널 자리
        <aside className="ai-panel" aria-label="AI 패널">
          <div className="ai-panel-head">
            <span>AI</span>
            <button
              type="button"
              className="icon-button"
              aria-label="AI 패널 닫기"
              onClick={() => setLayout((l) => ({ ...l, ai: false }))}
            >
              ✕
            </button>
          </div>
        </aside>
      )}

      {confirmTrash && (
        <ConfirmDialog
          title={`"${displayTitle(ix.byId.get(confirmTrash.id)?.title ?? "")}"을 휴지통으로 옮길까요?`}
          confirmLabel="휴지통으로 이동"
          onConfirm={() => void doTrash(confirmTrash.id)}
          onCancel={() => setConfirmTrash(null)}
          fallbackFocus={() => treeRef.current?.focus(openIdRef.current)}
        >
          {confirmTrash.count > 0 && (
            <p>
              하위 페이지 <strong>{confirmTrash.count}개</strong>도 함께 옮겨집니다.
            </p>
          )}
          <p>휴지통에서 언제든 복원할 수 있습니다.</p>
        </ConfirmDialog>
      )}

      {toast && <Toast key={toast.id} data={toast} onClose={() => setToastState(null)} />}
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const label = status.state === "saved" ? "저장됨" : status.state === "saving" ? "저장 중" : "저장 안 됨";
  return (
    // 입력할 때마다 바뀌므로 화면 읽기 도구에 알리지 않는다. 실패는 아래 띠(role=alert)가 알린다.
    <span className="save-status" data-state={status.state}>
      <span className="save-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty">
      <h1 className="empty-title">첫 페이지를 만드세요</h1>
      <p className="empty-text">페이지 안에 하위 페이지를 두어 노트를 정리할 수 있습니다. 모든 내용은 이 PC에만 저장됩니다.</p>
      <button type="button" className="button button-primary" onClick={onCreate}>
        새 페이지
      </button>
      <dl className="empty-keys">
        <dt>새 페이지</dt>
        <dd>
          <kbd>Ctrl</kbd>+<kbd>N</kbd>
        </dd>
        <dt>검색</dt>
        <dd>
          <kbd>Ctrl</kbd>+<kbd>K</kbd>
        </dd>
        <dt>블록 종류</dt>
        <dd>
          <kbd>/</kbd>
        </dd>
      </dl>
    </section>
  );
}
