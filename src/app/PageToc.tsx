// 목차(P5-6, 화면설계 S-06): 편집 영역 오른쪽 가장자리에 마우스를 대거나 Ctrl+Shift+O로 이 페이지의 제목 목록을 띄운다.
// 새 라이브러리 없이 편집기 문서의 heading 노드만 읽는다(pm 결정).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { EditorInstance } from "../editor/Editor";
import { stickyBottom } from "../editor/find";
import "./PageToc.css";

type Heading = { pos: number; level: number; text: string };

/** 문서 순서대로 제목들. 글 블록 안으로는 내려가지 않아 블록 수만큼만 돈다. */
function readHeadings(editor: EditorInstance): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") out.push({ pos, level: node.attrs.level as number, text: node.textContent.trim() });
    return !node.isTextblock && !node.isAtom;
  });
  return out;
}

const sameHeadings = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.pos === b[i].pos && h.level === b[i].level && h.text === b[i].text);

/** 입력이 멈춘 뒤 목록을 다시 읽는 간격. 긴 문서에서도 글자마다 읽지 않는다(NF-04). */
const READ_DELAY_MS = 200;
/** 띠에 이만큼 머물면 연다(지나가며 스치는 것을 거른다). */
const OPEN_DELAY_MS = 150;
/** 띠와 목록을 모두 떠난 뒤 닫기까지. */
const CLOSE_DELAY_MS = 300;
/** 제목으로 갈 때 도구 막대 아래에 두는 여백. */
const SCROLL_MARGIN = 24;
/** 지금 제목을 가르는 '읽는 선'(도구 막대 아래). */
const READ_LINE = 32;
const LIST_WIDTH = 240;
const LIST_INSET = 8;
/** 좁은 편집 영역에서 목록 왼쪽에 남겨 두는 본문 폭. */
const BODY_KEEP = 48;

type Place = { top: number; right: number; width: number; maxHeight: number };

/** 목록과 같은 층에 뜨는 편집기 메뉴(/ 메뉴, 링크 메뉴 같은 맥락 메뉴)가 열려 있는지. */
const menuOpen = () => !!document.querySelector(".slash-menu, [role='menu']");

type Props = {
  editor: EditorInstance;
  /** 본문 스크롤 영역(.content). 부모(.content-area)가 띠·목록의 기준이다. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** AI 패널이 열렸는지. 좁은 창에서는 본문 위에 겹치므로 그 왼쪽에 붙는다. */
  aiOpen: boolean;
};

export function PageToc({ editor, scrollerRef, aiOpen }: Props) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [open, setOpen] = useState<null | "hover" | "keyboard">(null);
  const [current, setCurrent] = useState(-1);
  const [place, setPlace] = useState<Place>({ top: 0, right: 0, width: LIST_WIDTH, maxHeight: 0 });
  const listRef = useRef<HTMLUListElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const items = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];

  // 문서가 바뀌면 입력이 멈춘 뒤 한 번 읽는다. 같으면 다시 그리지 않는다.
  useEffect(() => {
    const refresh = () => {
      const next = readHeadings(editor);
      setHeadings((cur) => (sameHeadings(cur, next) ? cur : next));
    };
    // 페이지를 바꾼 직후에는 옛 편집기가 먼저 올 수 있어, 편집기가 바뀌면 바로 다시 읽는다.
    refresh();
    let timer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!editor.isDestroyed) refresh();
      }, READ_DELAY_MS);
    };
    editor.on("update", onUpdate);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", onUpdate);
    };
  }, [editor]);

  /** 제목 DOM. 지워졌거나 목록을 다시 읽기 전(입력 직후)이라 그 자리가 이제 제목이 아니면 null. */
  const headingEl = useCallback(
    (h: Heading) => {
      if (h.pos >= editor.state.doc.content.size || editor.state.doc.nodeAt(h.pos)?.type.name !== "heading") return null;
      const el = editor.view.nodeDOM(h.pos);
      return el instanceof HTMLElement ? el : null;
    },
    [editor],
  );

  /** 도구 막대(sticky, 찾기 막대가 열렸으면 그 아래 끝) 아래, 보이는 편집 영역의 위 끝(화면 좌표). */
  const viewTop = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    return stickyBottom(scroller, scroller.getBoundingClientRect().top);
  }, [scrollerRef]);

  // 띠·목록 자리. 보이는 오른쪽 끝 = 스크롤 막대 왼쪽, AI 패널이 겹쳐 떠 있으면 그 왼쪽 경계.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const area = scroller?.parentElement;
    if (!scroller || !area || !headings.length) return;
    const measure = () => {
      const box = area.getBoundingClientRect();
      const ai = document.querySelector(".ai-panel")?.getBoundingClientRect();
      let right = box.right - (scroller.offsetWidth - scroller.clientWidth);
      if (ai && ai.width > 0 && ai.left < right) right = ai.left;
      const top = viewTop();
      const next: Place = {
        top: top - box.top,
        right: box.right - right,
        width: Math.max(0, Math.min(LIST_WIDTH, right - box.left - BODY_KEEP)),
        maxHeight: Math.max(0, box.bottom - top - 2 * LIST_INSET),
      };
      setPlace((p) =>
        p.top === next.top && p.right === next.right && p.width === next.width && p.maxHeight === next.maxHeight ? p : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(area);
    const bar = scroller.querySelector(".editor-toolbar");
    if (bar) ro.observe(bar);
    // 찾기 막대(S-14)는 열고 닫을 때 생기고 없어진다. 생기면 높이(바꾸기 펼침)도 지켜본다.
    let find: Element | null = null;
    const watchFind = () => {
      const next = bar?.parentElement?.querySelector(":scope > .find-bar") ?? null;
      if (next === find) return;
      if (find) ro.unobserve(find);
      find = next;
      if (find) ro.observe(find);
      measure();
    };
    watchFind();
    const mo = new MutationObserver(watchFind);
    if (bar?.parentElement) mo.observe(bar.parentElement, { childList: true });
    // 도구 막대는 sticky라 붙기 전에는 스크롤에 따라 아래 끝이 움직인다. 붙은 뒤에는 값이 같아 다시 그리지 않는다.
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollerRef, viewTop, aiOpen, headings.length]);

  /**
   * 지금 제목: 머리가 읽는 선 위에 있는 제목 중 마지막. 첫 제목보다 위를 보고 있으면 -1.
   * 끝까지 스크롤했으면 화면에 보이는 제목 중 마지막.
   */
  const findCurrent = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return -1;
    const line = viewTop() + READ_LINE;
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const limit = atEnd ? scroller.getBoundingClientRect().bottom : line;
    // 제목은 문서 순서라 위치가 아래로만 늘어난다. 선 아래 첫 제목에서 멈춘다.
    let at = -1;
    for (let i = 0; i < headings.length; i++) {
      const top = headingEl(headings[i])?.getBoundingClientRect().top;
      if (top === undefined) continue;
      if (top > limit) break;
      at = i;
    }
    return at;
  }, [headings, headingEl, scrollerRef, viewTop]);

  // 열려 있는 동안 지금 제목을 강조한다(스크롤마다 한 프레임에 한 번).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!open || !scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setCurrent(findCurrent());
    };
    update();
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [open, findCurrent, scrollerRef]);

  const clearHover = () => window.clearTimeout(hoverTimer.current);
  const hoverEnter = () => {
    clearHover();
    if (!open) hoverTimer.current = window.setTimeout(() => !menuOpen() && setOpen("hover"), OPEN_DELAY_MS);
  };

  // 마우스로 연 목록은 / 메뉴·링크 메뉴가 뜨면 닫는다. 같은 층(30)이라 좁은 창에서 메뉴를 덮는다(T-TOC-11).
  // 키보드로 연 목록은 포커스가 목록에 있어 메뉴가 뜨지 않고, 뜨면 바깥으로 포커스가 나가 닫힌다.
  useEffect(() => {
    if (open !== "hover") return;
    const mo = new MutationObserver(() => {
      if (menuOpen()) setOpen(null);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [open]);
  const hoverLeave = () => {
    clearHover();
    hoverTimer.current = window.setTimeout(() => setOpen((o) => (o === "hover" ? null : o)), CLOSE_DELAY_MS);
  };
  useEffect(() => clearHover, []);

  // 열 때 지금 제목이 목록 안에 보이게 하고, 키보드로 열었으면 그 항목(없으면 첫 항목)에 포커스를 둔다.
  // 여는 순간에만 한다(스크롤로 지금 제목이 바뀌어도 포커스를 빼앗지 않는다).
  useEffect(() => {
    // 강조(current)는 같은 때 다른 효과가 정하므로 여기서 직접 다시 구한다.
    if (!open) return;
    const item = items()[Math.max(0, findCurrent())];
    item?.scrollIntoView({ block: "nearest" });
    if (open === "keyboard") item?.focus();
  }, [open]);

  // 제목이 다 지워지면 닫는다.
  useEffect(() => {
    if (!headings.length) setOpen(null);
  }, [headings.length]);

  /** 목록을 닫고 열기 전 편집기 선택 자리로 돌아간다. */
  const closeToEditor = useCallback(() => {
    setOpen(null);
    editor.commands.focus(null, { scrollIntoView: false });
  }, [editor]);

  // Ctrl+Shift+O로 열고, 한 번 더 누르면 닫는다. 대화상자·메뉴가 열려 있거나 제목이 없으면 하지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "KeyO") return;
      e.preventDefault();
      if (document.querySelector("dialog[open], [role='menu']")) return;
      if (open === "keyboard") closeToEditor();
      else if (headings.length) {
        clearHover();
        setOpen("keyboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, headings.length, closeToEditor]);

  const go = (h: Heading) => {
    const scroller = scrollerRef.current;
    const el = headingEl(h);
    setOpen(null);
    if (!scroller || !el) return;
    // 스크롤하면 도구 막대가 위에 붙어(sticky) 보이는 위 끝이 바뀔 수 있어, 옮긴 뒤 한 번 더 잰다.
    for (let i = 0; i < 2; i++) scroller.scrollTop += el.getBoundingClientRect().top - viewTop() - SCROLL_MARGIN;
    // 커서를 제목 맨 앞에 둔다. 스크롤은 위에서 맞췄으므로 편집기가 다시 옮기지 않게 한다.
    editor.chain().setTextSelection(h.pos + 1).focus(null, { scrollIntoView: false }).run();
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const last = list.length - 1;
    const to = ({ ArrowDown: Math.min(i + 1, last), ArrowUp: Math.max(i - 1, 0), Home: 0, End: last } as Record<string, number>)[e.key];
    if (to !== undefined) {
      e.preventDefault();
      list[to].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeToEditor();
    }
  };

  if (!headings.length) return null;
  // 키보드로 들어갈 항목: 지금 제목, 없으면 첫 항목.
  const tabStop = current >= 0 ? current : 0;

  return (
    <>
      <div
        className="toc-edge"
        aria-hidden="true"
        style={{ top: place.top, right: place.right }}
        onMouseEnter={hoverEnter}
        onMouseLeave={hoverLeave}
      />
      {open && (
        <nav
          // 키보드로 열면 포커스를 프로그램으로 옮기므로, 마우스로 누른 뒤라도 고리가 보이게 클래스로 그린다(T-TOC-08).
          className={open === "keyboard" ? "toc toc--keyboard" : "toc"}
          aria-label="목차"
          aria-keyshortcuts="Control+Shift+O"
          style={{ top: place.top + LIST_INSET, right: place.right + LIST_INSET, width: place.width, maxHeight: place.maxHeight }}
          onMouseEnter={hoverEnter}
          onMouseLeave={hoverLeave}
          onBlur={(e) => {
            // 키보드로 연 목록에서 포커스가 밖으로 나가면(Tab·바깥 클릭) 닫는다.
            if (open === "keyboard" && !e.currentTarget.contains(e.relatedTarget)) setOpen(null);
          }}
        >
          <div className="toc-head" aria-hidden="true">
            목차
          </div>
          <ul ref={listRef} className="toc-list" onKeyDown={onListKey}>
            {headings.map((h, i) => (
              // 위쪽 입력으로 위치(pos)가 밀려도 항목을 다시 만들지 않게 순번으로 잇는다.
              <li key={i}>
                <button
                  type="button"
                  className="toc-item"
                  data-level={h.level}
                  data-empty={h.text ? undefined : ""}
                  aria-current={i === current ? "location" : undefined}
                  tabIndex={i === tabStop ? 0 : -1}
                  title={h.text || undefined}
                  // 마우스로 누를 때 편집기 포커스를 빼앗지 않는다. 키보드는 이미 목록에 있다.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(h)}
                >
                  {h.text || "(제목 없음)"}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  );
}
