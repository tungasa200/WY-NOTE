import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

/** 커서가 든 표의 시작 위치. 편집 영역에 포커스가 없거나 표 밖이면 null. */
function cursorTable(editor: Editor): number | null {
  if (!editor.view.hasFocus()) return null;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return $from.before(d);
  return null;
}

/** 세로로 스크롤되는 가장 가까운 조상. 없으면 null(창이 기준). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

const GAP = 4;

/**
 * 표 수정 도구(행·열 추가·삭제, 표 삭제). 커서가 표 안에 있을 때만 띄운다.
 * 자리는 표 바로 아래. 거기가 보이는 영역 밖이면 표 위, 그것도 안 되면(표가 화면보다 길면) 보이는 영역 아래쪽에 붙인다.
 * 버튼을 눌러도 편집 영역의 포커스·선택은 그대로 둔다(누를 때 포커스를 빼앗지 않는다).
 * 키보드: 표 안에서 Alt+F10으로 첫 버튼에 가고, Esc로 편집 영역에 돌아온다.
 */
export function TableTools({ editor, wrapRef }: { editor: Editor; wrapRef: RefObject<HTMLDivElement | null> }) {
  const table = useEditorState({ editor, selector: ({ editor: e }) => cursorTable(e) });
  // 문서가 바뀌면(행 추가 등) 표 높이가 바뀌므로 자리를 다시 잰다.
  const doc = useEditorState({ editor, selector: ({ editor: e }) => e.state.doc });
  const barRef = useRef<HTMLDivElement>(null);
  // 키보드 포커스가 도구 안에 있는 동안은 편집 영역이 포커스를 잃어도 그 표의 도구를 계속 보인다.
  const [held, setHeld] = useState<number | null>(null);
  const shown = table ?? held;

  // Alt+F10: 표 안에서는 Tab이 셀 이동이라 도구로 가는 키를 따로 둔다.
  useEffect(() => {
    if (table === null) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F10" || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      barRef.current?.querySelector("button")?.focus();
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor, table]);

  const placeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    if (!wrap || !bar) return;
    const el = shown === null ? null : editor.view.nodeDOM(shown);
    // 표 DOM을 못 찾으면 엉뚱한 자리에 띄우지 않고 숨긴다.
    if (!(el instanceof HTMLElement)) {
      bar.style.visibility = "hidden";
      return;
    }
    const scroller = scrollParent(wrap);
    const place = () => {
      const box = el.getBoundingClientRect();
      const wrapBox = wrap.getBoundingClientRect();
      const port = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      // 위에 붙는 편집기 도구 막대(sticky)에 가려진 곳은 보이는 영역에서 뺀다.
      const sticky = wrap.parentElement?.querySelector(".editor-toolbar")?.getBoundingClientRect();
      const view = { top: Math.max(port.top, sticky?.bottom ?? port.top), bottom: port.bottom };
      const h = bar.offsetHeight;
      const below = box.bottom + GAP;
      const above = box.top - GAP - h;
      const offscreen = box.top >= view.bottom || box.bottom <= view.top;
      let top = below;
      if (!offscreen && below + h > view.bottom) {
        top = above >= view.top ? above : view.bottom - GAP - h;
      }
      bar.style.top = `${top - wrapBox.top}px`;
      bar.style.left = `${box.left - wrapBox.left}px`;
      // 표가 스크롤로 보이는 영역을 벗어나면 숨긴다(위 도구 막대를 덮지 않게). 포커스가 도구 안이면 그대로 둔다.
      bar.style.visibility = offscreen && !bar.contains(document.activeElement) ? "hidden" : "";
    };
    placeRef.current = place;
    place();
    // 스크롤, 창 크기(본문이 가운데로 다시 놓임·보이는 높이) 바뀜에 다시 잰다.
    const resize = new ResizeObserver(place);
    resize.observe(wrap);
    if (scroller) resize.observe(scroller);
    const target = scroller ?? window;
    target.addEventListener("scroll", place, { passive: true });
    return () => {
      placeRef.current = null;
      resize.disconnect();
      target.removeEventListener("scroll", place);
    };
  }, [editor, wrapRef, shown]);

  // 문서가 바뀌면 자리만 다시 잰다(감시자는 다시 걸지 않는다).
  useLayoutEffect(() => placeRef.current?.(), [doc]);

  if (shown === null) return null;

  const run = () => editor.chain().focus();
  const tools = [
    { label: "행 추가", act: () => run().addRowAfter().run() },
    { label: "행 삭제", act: () => run().deleteRow().run() },
    { label: "열 추가", act: () => run().addColumnAfter().run() },
    { label: "열 삭제", act: () => run().deleteColumn().run() },
    { label: "표 삭제", act: () => run().deleteTable().run() },
  ];
  return (
    <div
      ref={barRef}
      className="table-tools"
      role="toolbar"
      aria-label="표 수정"
      aria-keyshortcuts="Alt+F10"
      onFocus={() => setHeld(shown)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation(); // 위쪽의 Esc 처리(패널 닫기 등)까지 가지 않게
        editor.commands.focus(); // 원래 셀(선택)로 돌아간다
      }}
    >
      {tools.map(({ label, act }) => (
        <button key={label} type="button" className="editor-button" onMouseDown={(e) => e.preventDefault()} onClick={act}>
          {label}
        </button>
      ))}
    </div>
  );
}
