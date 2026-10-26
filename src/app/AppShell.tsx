// 앱 셸(화면설계 S-01): 사이드바 · 편집 영역 · AI 패널 자리. 트리(S-02), 빈 상태(S-09), 저장 실패(S-10)를 묶는다.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorReason } from "../api";
import { AiPanel } from "../ai/AiPanel";
import { createEditorTarget } from "../ai/editorTarget";
import type { EditorInstance } from "../editor/Editor";
import { SearchPanel, type RecentPage } from "../features/search/SearchPanel";
import { TrashPanel } from "../features/trash/TrashPanel";
import { ConfirmDialog } from "../lib/ConfirmDialog";
import type { JSONContent, Page, PageId, TrashItem, TreeNode, UiState } from "../lib/db-types";
import { displayTitle, quoteObject } from "../lib/title";
import { PageTree, type PageTreeHandle } from "../tree/PageTree";
import { ancestors, descendantIds, indexTree } from "../tree/tree";
import { Autosaver, type SaveStatus } from "./autosave";
import { CloseSaveDialog } from "./CloseSaveDialog";
import { PageView } from "./PageView";
import { SettingsView } from "./SettingsView";
import { Toast, type ToastData } from "./Toast";
import "./AppShell.css";

type View = "page" | "trash" | "settings";

const CLOSE_SAVE_TIMEOUT_MS = 3000;
// 검색 전 저장을 이보다 오래 기다리지 않는다(저장이 멈춰도 검색은 된다).
const SEARCH_SAVE_WAIT_MS = 1000;
const RECENT_MAX = 5;

type Layout = { sidebar: boolean; ai: boolean };

/** 경로 표시("업무 / 회의록"). 경로 띠의 생략 부분과 검색 결과가 함께 쓴다. */
const pathLabel = (nodes: TreeNode[]) => nodes.map((n) => displayTitle(n.title)).join(" / ");

/** p가 끝나거나 ms가 지나면 끝난다. */
function within(p: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]).finally(() => clearTimeout(timer));
}

/** 저장한 화면 상태를 읽는다. 모르는 값·빠진 값은 기본값. */
function readUiState(v: UiState): { layout: Layout; recent: PageId[] } {
  const ids = Array.isArray(v.recentPageIds) ? v.recentPageIds.filter((n) => typeof n === "number") : [];
  return {
    layout: {
      sidebar: typeof v.sidebarCollapsed === "boolean" ? !v.sidebarCollapsed : true,
      ai: typeof v.aiPanelOpen === "boolean" ? v.aiPanelOpen : false,
    },
    recent: ids.slice(0, RECENT_MAX),
  };
}

type ClosePrompt = { reason: string; titles: string[]; busy: boolean };

export function AppShell() {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [openId, setOpenId] = useState<PageId | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const [view, setView] = useState<View>("page");
  // 열린 페이지의 편집기. AI 패널이 선택·본문을 읽고 결과를 넣는다.
  const [editor, setEditor] = useState<EditorInstance | null>(null);
  const onEditor = useCallback((ed: EditorInstance, attached: boolean) => {
    // 페이지를 바꾸면 새 편집기가 먼저 붙고 옛 편집기가 나중에 떨어질 수 있다: 지금 편집기일 때만 비운다.
    setEditor((cur) => (attached ? ed : cur === ed ? null : cur));
  }, []);
  const aiTarget = useMemo(() => (editor ? createEditorTarget(editor) : null), [editor]);
  const [layout, setLayout] = useState<Layout>({ sidebar: true, ai: false });
  // 저장한 화면 상태를 받기 전에 사용자가 바꿨으면, 늦게 온 저장값으로 덮지 않는다.
  const layoutTouched = useRef(false);
  const updateLayout = (f: (l: Layout) => Layout) => {
    layoutTouched.current = true;
    setLayout(f);
  };
  const [recent, setRecent] = useState<PageId[]>([]);
  // 저장한 화면 상태(마지막으로 보낸 값). 읽기 전·읽지 못했으면(null) 쓰지 않는다(기본값으로 덮지 않게).
  // 이 화면이 다루지 않는 키(테마·너비)도 그대로 돌려 쓴다.
  const uiSaved = useRef<UiState | null>(null);
  const [uiLoaded, setUiLoaded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // 휴지통 화면이 열린 채 트리에서 옮기거나 되살리면 목록을 다시 읽게 한다.
  const [trashVersion, setTrashVersion] = useState(0);
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
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
        // 저장 대기분(실패·다시 시도 중인 것 포함)이 있으면 DB 본문 대신 그것으로 연다(pm 결정).
        // 읽는 사이 그 저장이 끝나도 놓치지 않게 읽기 전 값도 본다.
        const before = saver.pendingContent(id);
        const loaded = opts.created ?? (await api.getPage(id));
        if (seq !== openSeq.current) return;
        const pending = saver.pendingContent(id) ?? before;
        setPage(pending ? { ...loaded, content: pending } : loaded);
        setOpenId(id);
        openIdRef.current = id;
        setSaveStatus(saver.status(id));
        setFocusTitle(!!opts.created);
        setRecent((r) => (r[0] === id ? r : [id, ...r.filter((x) => x !== id)].slice(0, RECENT_MAX)));
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
        if (!alive) return;
        if (start !== null) await openPage(start, { treeIndex: tix });
      } catch (e) {
        if (alive) setLoadError(errorReason(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadTree, openPage]);

  // 화면 상태(F-07)는 트리와 따로 읽어 오는 대로 반영한다. 읽지 못하면 이번 실행에서는 저장하지 않는다.
  useEffect(() => {
    let alive = true;
    api.getUiState().then(
      (raw) => {
        if (!alive) return;
        // 깨진 값(null·배열 등)은 저장한 적 없음으로 본다.
        const ui: UiState = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
        const saved = readUiState(ui);
        if (!layoutTouched.current) setLayout(saved.layout);
        // 그새 연 페이지가 앞에 온다.
        setRecent((r) => [...r, ...saved.recent.filter((id) => !r.includes(id))].slice(0, RECENT_MAX));
        uiSaved.current = ui;
        setUiLoaded(true);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  // 새로고침·창 닫기 직전 남은 저장을 보낸다. 저장 호출은 동기적으로 시작된다(autosave.ts).
  useEffect(() => {
    const onUnload = () => void saver.flushAll();
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [saver]);

  /** 남은 저장을 보내고 기다린다(최대 3초). 다 저장됐으면 null, 아니면 화면에 보일 이유. */
  const saveBeforeClose = useCallback(async (): Promise<ClosePrompt | null> => {
    await within(saver.flushAll(), CLOSE_SAVE_TIMEOUT_MS);
    const ids = saver.pendingIds();
    if (ids.length === 0) return null;
    const error = saver.firstError();
    return {
      reason: error !== undefined ? errorReason(error) : "저장이 끝나지 않았습니다",
      titles: ids.map((id) => displayTitle(ixRef.current.byId.get(id)?.title ?? "")),
      busy: false,
    };
  }, [saver]);

  // 창 닫기(X·Alt+F4): 남은 저장이 끝난 뒤 닫는다. 저장하지 못했으면 닫지 않고 묻는다(결정 db-v2).
  // onCloseRequested는 핸들러를 기다린 뒤 preventDefault가 없으면 스스로 destroy()를 부른다.
  // destroy에는 capabilities의 core:window:allow-destroy가 필요하다(없으면 창이 닫히지 않는다).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const prompt = await saveBeforeClose();
        if (prompt === null) return;
        event.preventDefault();
        setClosePrompt(prompt);
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [saveBeforeClose]);

  const retryCloseSave = async () => {
    setClosePrompt((p) => p && { ...p, busy: true });
    const prompt = await saveBeforeClose();
    if (prompt === null) void getCurrentWindow().destroy();
    else setClosePrompt(prompt);
  };

  useEffect(() => {
    if (!uiLoaded || !uiSaved.current) return;
    const next = { ...uiSaved.current, sidebarCollapsed: !layout.sidebar, aiPanelOpen: layout.ai, recentPageIds: recent };
    if (JSON.stringify(next) === JSON.stringify(uiSaved.current)) return; // 바뀐 게 없으면 보내지 않는다
    // 성공한 뒤에만 기억한다(실패하면 다음 변경 때 다시 보낸다).
    api.setUiState(next).then(
      () => (uiSaved.current = next),
      () => {},
    );
  }, [uiLoaded, layout, recent]);

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
    setTrashVersion((v) => v + 1);
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
      message: `${quoteObject(node.title)} 휴지통으로 옮겼습니다`,
      action: {
        label: "실행 취소",
        run: async () => {
          try {
            await api.restorePage(id);
            setTrashVersion((v) => v + 1);
            await reloadTree();
          } catch (e) {
            showError(e);
          }
        },
      },
    });
  };

  const onRestored = (item: TrashItem) => {
    void reloadTree();
    setToast({
      message: `${quoteObject(item.title)} 복원했습니다`,
      action: { label: "열기", run: () => void openPage(item.id) },
    });
  };

  // 검색어를 보낼 때 저장 대기 중인 내용을 먼저 저장한다(방금 입력한 내용도 찾게, 결정 spec-details).
  const searchSaved = useCallback(
    async (query: string) => {
      await within(saver.flushAll(), SEARCH_SAVE_WAIT_MS);
      return api.search(query);
    },
    [saver],
  );

  /**
   * 페이지 화면을 떠나 휴지통·설정으로 간다. 남은 저장을 보내고 들고 있던 본문을 버린다:
   * 편집기는 본문을 만들 때 한 번만 읽으므로, 돌아올 때 openPage가 새로 읽은 본문으로 다시 그리게 한다.
   */
  const leavePage = useCallback(
    (to: Exclude<View, "page">) => {
      // 아직 읽는 중인 페이지 열기는 버린다(늦게 도착해 이 화면 뒤에서 열리지 않게).
      openSeq.current++;
      if (openIdRef.current !== null) void saver.flush(openIdRef.current);
      setPage(null);
      setView(to);
    },
    [saver],
  );
  const openSettings = useCallback(() => leavePage("settings"), [leavePage]);
  const closeAi = useCallback(() => {
    layoutTouched.current = true;
    setLayout((l) => ({ ...l, ai: false }));
  }, []);

  // 전역 단축키(S-01).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      // e.key는 한글 입력 상태에서 자모가 될 수 있어 키 위치(e.code)로 본다.
      const action = {
        KeyK: () => setSearchOpen(true),
        KeyN: () => void createPage(null),
        Backslash: () => updateLayout((l) => ({ ...l, sidebar: !l.sidebar })),
        KeyJ: () => updateLayout((l) => ({ ...l, ai: !l.ai })),
        Comma: openSettings,
      }[e.code];
      if (!action) return;
      e.preventDefault(); // 대화상자가 열려 있어도 WebView 기본 동작(Ctrl+N 새 창 등)은 막는다
      // 대화상자·메뉴가 열린 동안은 뒤 화면을 바꾸지 않는다.
      if (!document.querySelector("dialog[open], [role='menu']")) action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createPage, openSettings]);

  // 릴리스에서는 새로 고침을 막는다(편집 상태가 날아간다). 확대(Ctrl+±·휠)는 막지 않는다.
  // WebView2 기본 오른쪽 클릭 메뉴에도 '새로 고침'이 있어, 글을 고치는 곳(편집기·입력칸) 밖에서는 띄우지 않는다.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.ctrlKey && !e.altKey && e.code === "KeyR")) e.preventDefault();
    };
    const onMenu = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onMenu);
    };
  }, []);

  const openNode = openId !== null ? ix.byId.get(openId) : undefined;
  const path = openId !== null ? ancestors(ix, openId) : [];
  // 깊은 경로는 맨 위 하나와 가까운 둘만 보이고 가운데는 "…"로 줄인다.
  const crumbs = path.length > 3 ? [path[0], null, ...path.slice(-2)] : path;
  const hiddenCrumbs = path.length > 3 ? pathLabel(path.slice(1, -2)) : "";
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
              onClick={() => updateLayout((l) => ({ ...l, sidebar: false }))}
            >
              ◧
            </button>
          </div>
          <button
            type="button"
            className="sidebar-new sidebar-search"
            aria-haspopup="dialog"
            aria-keyshortcuts="Control+K"
            onClick={() => setSearchOpen(true)}
          >
            검색
            <span className="sidebar-search-keys" aria-hidden="true">
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </span>
          </button>
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
              onClick={() => leavePage("trash")}
            >
              휴지통
            </button>
            <button
              type="button"
              className="sidebar-link"
              aria-current={view === "settings" ? "page" : undefined}
              aria-keyshortcuts="Control+,"
              title="설정 (Ctrl+,)"
              onClick={openSettings}
            >
              설정
            </button>
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
              onClick={() => updateLayout((l) => ({ ...l, sidebar: true }))}
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
            onClick={() => updateLayout((l) => ({ ...l, ai: !l.ai }))}
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
          ) : view === "settings" ? (
            <SettingsView />
          ) : view === "trash" ? (
            <TrashPanel
              key={trashVersion}
              list={api.listTrash}
              restore={api.restorePage}
              deletePermanently={api.deletePagePermanently}
              empty={api.emptyTrash}
              onRestored={onRestored}
            />
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
              onEditor={onEditor}
            />
          ) : null}
        </div>
      </main>

      {layout.ai && (
        <aside className="ai-panel" aria-label="AI 패널">
          <AiPanel
            pageId={view === "page" ? openId : null}
            target={view === "page" ? aiTarget : null}
            onClose={closeAi}
            onOpenSettings={openSettings}
          />
        </aside>
      )}

      {confirmTrash && (
        <ConfirmDialog
          title={`${quoteObject(ix.byId.get(confirmTrash.id)?.title ?? "")} 휴지통으로 옮길까요?`}
          confirmLabel="휴지통으로 이동"
          initialFocus="confirm"
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

      {searchOpen && (
        <SearchPanel
          search={searchSaved}
          recent={recent.flatMap((id): RecentPage[] => {
            const n = ix.byId.get(id);
            return n ? [{ pageId: id, title: n.title }] : [];
          })}
          pathOf={(id) => pathLabel(ancestors(ix, id))}
          onOpenPage={async (id) => {
            // 첫 일치 위치로 스크롤·강조(S-05)는 편집기 쪽 기능이 생기면 query로 붙인다.
            setSearchOpen(false);
            await openPage(id);
            // 연 페이지의 본문으로 포커스를 옮긴다(검색창은 연 곳으로 돌려주지 않는다).
            // 열지 못했으면(실패·다른 열기가 앞섬) 트리의 열린 페이지로 돌린다.
            requestAnimationFrame(() => {
              if (openIdRef.current === id) document.querySelector<HTMLElement>(".editor-body")?.focus();
              else treeRef.current?.focus(openIdRef.current);
            });
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {closePrompt && (
        <CloseSaveDialog
          reason={closePrompt.reason}
          titles={closePrompt.titles}
          busy={closePrompt.busy}
          onRetry={() => void retryCloseSave()}
          onCloseAnyway={() => void getCurrentWindow().destroy()}
          onDismiss={() => setClosePrompt(null)}
        />
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
