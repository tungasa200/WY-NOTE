// 페이지 안 찾기·바꾸기 막대(S-14, F-11). 도구 막대 아래 고정 머리의 두 번째 줄.
// 찾기·강조·바꾸기는 find.ts, 이 파일은 입력·키·포커스·낭독만 맡는다.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { ToastData } from "../app/Toast";
import {
  MARK_LIMIT,
  clearFind,
  findKey,
  findResult,
  findSession,
  moveFind,
  normalizeQuery,
  onFindCommand,
  replaceAll,
  replaceCurrent,
  runFind,
  type FindCommand,
  type FindResult,
} from "./find";
import { Icon } from "./icons";

const TYPE_MS = 100;
/** 본문 선택을 찾는 말로 넣는 상한(S-14 "한 줄짜리 글 200자 이하"). */
const FILL_MAX = 200;

const num = (n: number) => n.toLocaleString("ko-KR");
const LIMIT = num(MARK_LIMIT);
const NONE = "일치하는 글이 없습니다";

/** 1,000개를 넘었는지, 지금 위치도 1,000번째를 넘었는지(pm 결정 2: `n / 1,000+`·`1,000+ / 1,000+`). */
const over = ({ total, current }: FindResult) => ({ total: total > MARK_LIMIT, pos: current + 1 > MARK_LIMIT });

function spoken(r: FindResult, prefix = "") {
  if (!r.total) return NONE;
  const o = over(r);
  // 개수 칸과 맞춘다(pm 결정).
  if (o.total) return `${prefix}${LIMIT}개 넘게 찾음, ${o.pos ? `${LIMIT}번째 넘음` : `${num(r.current + 1)}번째`}`;
  return `${prefix}${num(r.total)}개 중 ${num(r.current + 1)}번째`;
}

const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

type Pending = { focus?: "find" | "replace"; find?: 1 | -1 };

export function FindBar({ editor, onToast }: { editor: Editor; onToast?: (t: ToastData) => void }) {
  const [open, setOpen] = useState(findSession.open);
  const [expanded, setExpanded] = useState(findSession.expanded);
  const [query, setQueryState] = useState(findSession.query);
  const [replacement, setReplacementState] = useState(findSession.replacement);
  const [live, setLive] = useState("");
  const found = useEditorState({ editor, selector: ({ editor: e }) => findResult(e.state) });

  const barRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const repRef = useRef<HTMLInputElement>(null);
  const rowId = useId();
  /** 열기 전 커서 자리. 처음 찾을 때 이 뒤의 첫 일치가 지금 일치다. */
  const origin = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Pending | null>(null);
  const [tick, setTick] = useState(0);

  const setQuery = (q: string) => {
    findSession.query = q;
    setQueryState(q);
  };
  const setReplacement = (r: string) => {
    findSession.replacement = r;
    setReplacementState(r);
  };
  /** 입력 중 미뤄 둔 찾기를 버린다. */
  const cancelTyping = () => {
    clearTimeout(typing.current);
    typing.current = undefined;
  };
  // 같은 문장도 다시 읽히게 끝에 보이지 않는 글자를 번갈아 붙인다.
  const announce = (text: string) => setLive((prev) => (prev === text ? `${text} ` : text));

  /** 입력 중 미뤄 둔 찾기를 지금 한다. 이미 그 말로 찾아 두었으면 false. */
  const flush = (dir: 1 | -1 = 1) => {
    cancelTyping();
    const view = editor.view;
    if (findKey.getState(view.state)?.query === normalizeQuery(findSession.query)) return false;
    announce(spoken(runFind(view, findSession.query, origin.current, dir)));
    return true;
  };

  const go = (dir: 1 | -1) => {
    if (!findSession.query || flush(dir)) return;
    announce(spoken(moveFind(editor.view, dir)));
  };

  const close = () => {
    cancelTyping();
    if (findSession.open) holdScroll();
    findSession.open = false;
    setOpen(false);
    clearFind(editor.view);
    editor.view.focus();
  };

  // 앱 단축키(AppShell)에서 오는 명령. 지금 값은 findSession·ref로 읽는다.
  const command = useRef<(c: FindCommand) => void>(() => {});
  command.current = (c) => {
    if (editor.isDestroyed) return;
    const view = editor.view;
    const wasOpen = findSession.open;
    const inside = !!barRef.current?.contains(document.activeElement);
    let changed = false;
    if (!inside) {
      const { from, to, empty } = view.state.selection;
      origin.current = from;
      if ((c === "find" || c === "replace") && !empty && view.hasFocus()) {
        const text = view.state.doc.textBetween(from, to, "\n");
        if (text && !text.includes("\n") && text.length <= FILL_MAX && text !== findSession.query) {
          setQuery(text);
          changed = true;
        }
      }
    }
    if ((c === "next" || c === "prev") && wasOpen) {
      go(c === "next" ? 1 : -1);
      return;
    }
    if (!wasOpen || (c === "replace" && !findSession.expanded)) holdScroll();
    findSession.open = true;
    setOpen(true);
    if (c === "replace") {
      findSession.expanded = true;
      setExpanded(true);
    }
    const dir = c === "prev" ? -1 : 1;
    const research = !wasOpen || !inside || changed;
    pending.current = {
      focus: c === "replace" && findSession.query ? "replace" : "find",
      find: research && findSession.query ? dir : undefined,
    };
    setTick((t) => t + 1);
  };
  useEffect(() => onFindCommand((c) => command.current(c)), []);

  // 페이지를 바꿔도 막대는 열린 채로 새 페이지에서 같은 말로 다시 찾는다(포커스는 옮기지 않는다).
  // 편집기는 자동 포커스(커서 자리)를 정한 뒤 create를 알린다.
  useEffect(() => {
    if (!findSession.open || !findSession.query) return;
    const start = () => {
      origin.current = editor.state.selection.from;
      runFind(editor.view, findSession.query, origin.current);
    };
    if (editor.isInitialized) start();
    else {
      editor.once("create", start);
      return () => void editor.off("create", start);
    }
  }, [editor]);

  useEffect(() => () => clearTimeout(typing.current), []);

  // 막대를 열고 닫거나 바꾸기 줄을 펴고 접어도 보이던 글이 밀리지 않게(S-14), 바뀌기 전 본문 위치를 재 두고
  // 바뀐 뒤 실제로 움직인 만큼 스크롤을 되돌린다. 브라우저 scroll anchoring이 따로 보정하면 두 번 움직이므로
  // 그동안만 끄고 두 프레임 뒤 되살린다. 맨 위(0)·문서 끝처럼 스크롤로 다 못 맞추는 몫은 그대로 둔다.
  const hold = useRef<{ scroller: HTMLElement; top: number } | null>(null);
  const holdScroll = () => {
    if (hold.current || editor.isDestroyed) return;
    const scroller = editor.view.dom.closest<HTMLElement>(".content");
    if (!scroller) return;
    scroller.style.overflowAnchor = "none";
    hold.current = { scroller, top: editor.view.dom.getBoundingClientRect().top };
  };
  // 지금 일치로 옮기는 스크롤(아래 효과)보다 먼저 한다. 높이가 안 바뀌는 렌더도 있어 의존성 없이 돈다.
  useLayoutEffect(() => {
    const h = hold.current;
    if (!h) return;
    hold.current = null;
    if (!editor.isDestroyed) h.scroller.scrollTop += editor.view.dom.getBoundingClientRect().top - h.top;
    // 그 사이 또 바뀌면(연달아 펴고 접기) 뒤 변경이 되살린다.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!hold.current) h.scroller.style.removeProperty("overflow-anchor");
      }),
    );
  });

  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.find) {
      cancelTyping();
      announce(spoken(runFind(editor.view, findSession.query, origin.current, p.find)));
    }
    const input = p.focus === "replace" ? repRef.current : findRef.current;
    input?.focus();
    input?.select();
  }, [tick, editor]);

  const onQueryChange = (q: string) => {
    setQuery(q);
    clearTimeout(typing.current);
    // 한글 조합 중인 글자까지 넣어 찾는다(사용자 결정 ③). 강조는 본문에만 그려 입력칸 조합을 건드리지 않는다.
    typing.current = setTimeout(() => {
      typing.current = undefined;
      const r = runFind(editor.view, q, origin.current);
      announce(q ? spoken(r) : "");
    }, TYPE_MS);
  };

  /** 지금 누른 버튼이 꺼지게 되면 포커스를 바꿀 말 입력칸으로 옮긴다(body로 빠지지 않게). */
  const keepFocus = (r: FindResult | null) => {
    if (!r?.total && document.activeElement?.matches(".find-bar button")) repRef.current?.focus();
  };

  const replaceOne = () => {
    cancelTyping();
    const r = replaceCurrent(editor.view, findSession.query, findSession.replacement, origin.current);
    announce(r ? spoken(r, "바꿈, ") : NONE);
    keepFocus(r);
  };

  const replaceEvery = () => {
    cancelTyping();
    const n = replaceAll(editor.view, findSession.query, findSession.replacement);
    keepFocus(findResult(editor.state));
    if (!n) {
      announce(NONE);
      return;
    }
    // 낭독은 알림 문장 그대로(알림 영역이 읽는다). 알림이 떠 있는 동안 본문이 다른 편집으로 바뀌면 실행 취소를 거둔다.
    onToast?.({
      message: `${num(n)}개를 바꿨습니다`,
      action: {
        label: "실행 취소",
        run: () => void editor.commands.undo(),
        until: (withdraw) => {
          editor.on("update", withdraw);
          editor.on("destroy", withdraw);
          return () => {
            editor.off("update", withdraw);
            editor.off("destroy", withdraw);
          };
        },
      },
    });
  };

  const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !composing(e)) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // 버튼에 포커스가 있으면 실행 취소 키는 본문으로(입력칸 안에서는 입력칸 글자를 되돌린다).
    if (e.ctrlKey && !e.altKey && (e.target as Element).matches("button")) {
      const redo = e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey);
      if (redo || e.code === "KeyZ") {
        e.preventDefault();
        if (redo) editor.commands.redo();
        else editor.commands.undo();
      }
    }
  };

  const toggle = () => {
    holdScroll();
    findSession.expanded = !expanded;
    setExpanded(!expanded);
  };

  const none = !query || !found.total;
  const o = over(found);
  const at = o.pos ? `${LIMIT}+` : num(found.current + 1);
  const count = !query ? "" : none ? "없음" : `${at} / ${o.total ? `${LIMIT}+` : num(found.total)}`;

  return (
    <>
      {open && (
        <div
          ref={barRef}
          className="find-bar"
          role="search"
          aria-label="페이지 안 찾기와 바꾸기"
          onKeyDown={onBarKeyDown}
          // 버튼을 눌러도 입력칸 포커스를 그대로 둔다(도구 막대와 같다). 꺼진 버튼은 mousedown이 오지 않아 pointerdown에서 막는다.
          onPointerDown={(e) => {
            if ((e.target as Element).closest("button")) e.preventDefault();
          }}
        >
          <div className="find-row">
            <button
              type="button"
              className="editor-button"
              aria-label="바꾸기"
              title="바꾸기 (Ctrl+H)"
              aria-expanded={expanded}
              aria-controls={rowId}
              aria-keyshortcuts="Control+H"
              onClick={toggle}
            >
              <Icon name={expanded ? "chevronDown" : "chevronRight"} />
            </button>
            <input
              ref={findRef}
              className="find-input"
              type="search"
              placeholder="페이지에서 찾기"
              aria-label="페이지에서 찾을 말"
              aria-keyshortcuts="Control+F"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || composing(e) || e.ctrlKey || e.altKey) return;
                e.preventDefault();
                go(e.shiftKey ? -1 : 1);
              }}
            />
            <span className="find-count" aria-hidden="true">
              {count}
            </span>
            <span className="find-buttons">
              <button
                type="button"
                className="editor-button"
                aria-label="이전 일치"
                title="이전 일치 (Shift+Enter)"
                disabled={none}
                onClick={() => go(-1)}
              >
                <Icon name="chevronUp" />
              </button>
              <button
                type="button"
                className="editor-button"
                aria-label="다음 일치"
                title="다음 일치 (Enter)"
                disabled={none}
                onClick={() => go(1)}
              >
                <Icon name="chevronDown" />
              </button>
            </span>
            <button
              type="button"
              className="editor-button find-close"
              aria-label="찾기 닫기"
              title="찾기 닫기 (Esc)"
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </div>
          {expanded && (
            <div className="find-row find-replace" id={rowId}>
              <input
                ref={repRef}
                className="find-input"
                type="text"
                placeholder="바꿀 말"
                aria-label="바꿀 말"
                autoComplete="off"
                spellCheck={false}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || composing(e) || e.shiftKey) return;
                  if (e.ctrlKey !== e.altKey) return;
                  e.preventDefault();
                  if (e.ctrlKey) replaceEvery();
                  else replaceOne();
                }}
              />
              <span className="find-buttons">
                <button
                  type="button"
                  className="editor-button"
                  aria-label="바꾸기"
                  title="바꾸기 (Enter)"
                  aria-keyshortcuts="Enter"
                  disabled={none}
                  onClick={replaceOne}
                >
                  <Icon name="replace" />
                </button>
                <button
                  type="button"
                  className="editor-button"
                  aria-label="모두 바꾸기"
                  title="모두 바꾸기 (Ctrl+Alt+Enter)"
                  aria-keyshortcuts="Control+Alt+Enter"
                  disabled={none}
                  onClick={replaceEvery}
                >
                  <Icon name="replaceAll" />
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {open ? live : ""}
      </div>
    </>
  );
}
