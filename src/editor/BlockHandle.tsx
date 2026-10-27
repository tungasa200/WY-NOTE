import { useEffect, useLayoutEffect, useState, type DragEvent, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { Icon } from "./icons";
import { insertSlashBlock } from "./slashMenu";

/** 손잡이를 블록 본문 왼쪽 바깥으로 얼마나 띄우는가(S-06). */
const OFFSET = 52;
const BUTTON_HEIGHT = 24;

/** 커서가 있는 최상위 블록의 시작 위치. 편집 영역에 포커스가 없으면 null. */
function cursorBlock(editor: Editor): number | null {
  if (!editor.view.hasFocus()) return null;
  const { $from } = editor.state.selection;
  return $from.depth > 0 ? $from.before(1) : editor.state.selection.from;
}

/**
 * 블록 왼쪽 손잡이(F-02.7, S-06. pm 결정으로 직접 구현).
 * - `+`: 아래에 빈 블록을 만들고 / 메뉴를 연다.
 * - `⋮⋮` 클릭: 블록을 선택한다. 끌기: 블록을 노드 선택으로 잡아 ProseMirror 기본 끌어 놓기에 맡긴다.
 *   그래서 놓을 자리 표시는 Dropcursor가, 이동은 트랜잭션 하나(실행 취소 한 번)로 처리된다.
 * 마우스 전용이라 화면 낭독기에서는 숨긴다. 키보드는 `/`와 Alt+↑/↓를 쓴다.
 */
export function BlockHandle({ editor, wrapRef }: { editor: Editor; wrapRef: RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [docVersion, setDocVersion] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const pos = hover ?? cursor;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 레이아웃을 읽으므로 마우스 이동은 한 프레임에 한 번만 처리한다.
    let frame = 0;
    let lastY = 0;
    const findHover = () => {
      frame = 0;
      const view = editor.view;
      const dom = view.dom;
      const box = dom.getBoundingClientRect();
      // 손잡이 쪽 여백에 있어도 같은 줄의 블록을 찾도록 본문 가운데에서 찾는다.
      let el = document.elementFromPoint(box.left + box.width / 2, lastY);
      while (el && el.parentElement !== dom) el = el.parentElement;
      if (!el) return;
      // 글이 든 블록은 안쪽 시작, 이미지·구분선 같은 잎 블록은 블록 앞 위치가 나온다. 둘 다 최상위 블록 앞으로 맞춘다.
      const $p = view.state.doc.resolve(view.posAtDOM(el, 0));
      setHover($p.depth ? $p.before(1) : $p.pos);
    };
    const onMove = (e: MouseEvent) => {
      lastY = e.clientY;
      frame ||= requestAnimationFrame(findHover);
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      setHover(null);
    };
    const onSelection = () => setCursor(cursorBlock(editor));
    // 입력으로 블록 위치가 바뀌면 손잡이가 엉뚱한 블록을 가리키지 않게 마우스 위치를 버린다.
    const onUpdate = () => {
      setHover(null);
      setCursor(cursorBlock(editor));
      setDocVersion((v) => v + 1);
    };
    // 창 폭이 바뀌면 본문이 가운데로 다시 놓이므로 손잡이 자리를 다시 잰다(높이 변화는 update가 맡는다).
    let width = wrap.clientWidth;
    const resize = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      setDocVersion((v) => v + 1);
    });
    resize.observe(wrap);
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);
    editor.on("selectionUpdate", onSelection);
    editor.on("focus", onSelection);
    editor.on("blur", onSelection);
    editor.on("update", onUpdate);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", onLeave);
      editor.off("selectionUpdate", onSelection);
      editor.off("focus", onSelection);
      editor.off("blur", onSelection);
      editor.off("update", onUpdate);
    };
  }, [editor, wrapRef]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = pos === null ? null : editor.view.nodeDOM(pos);
    if (!wrap || !(el instanceof HTMLElement)) {
      setPlace(null);
      return;
    }
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3 || 24;
    const box = el.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    // 첫 줄 높이의 세로 가운데에 맞춘다. 자리가 같으면 다시 그리지 않는다.
    const top = box.top - wrapBox.top + parseFloat(style.paddingTop || "0") + (lineHeight - BUTTON_HEIGHT) / 2;
    const left = box.left - wrapBox.left - OFFSET;
    setPlace((p) => (p?.top === top && p.left === left ? p : { top, left }));
  }, [editor, wrapRef, pos, docVersion]);

  if (pos === null || !place) return null;

  const selectBlock = () => {
    const view = editor.view;
    const selection = NodeSelection.create(view.state.doc, pos);
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
    return selection;
  };

  const addBelow = () => {
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const after = pos + node.nodeSize;
    // `/`를 넣어 / 메뉴를 연다. 고르지 않고 닫으면 그 `/`는 지운다(P5-1).
    insertSlashBlock(editor, after);
  };

  const onDragStart = (e: DragEvent) => {
    const view = editor.view;
    const selection = selectBlock();
    const slice = selection.content();
    const { dom, text } = view.serializeForClipboard(slice);
    e.dataTransfer.clearData();
    e.dataTransfer.setData("text/html", dom.innerHTML);
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copyMove";
    const blockDom = view.nodeDOM(pos);
    if (blockDom instanceof HTMLElement) e.dataTransfer.setDragImage(blockDom, 0, 0);
    // 끌리는 동안 원래 자리의 블록(선택된 블록)을 반투명하게 둔다(S-06).
    // ProseMirror가 그리는 노드에 직접 class를 달면 다시 그리면서 지우므로 바깥 틀에 단다.
    // 끌기 그림을 찍은 뒤에 반투명하게 한다.
    requestAnimationFrame(() => wrapRef.current?.classList.add("is-dragging"));
    // node를 함께 넘겨야 놓을 때 원래 블록을 통째로 지운다. 없으면 그때의 선택만 지워 빈 문단이 남는다.
    // (prosemirror-view는 node를 받지만 타입 선언에는 없다.)
    view.dragging = { slice, move: true, node: selection } as typeof view.dragging;
  };

  const onDragEnd = () => {
    wrapRef.current?.classList.remove("is-dragging");
    // 편집 영역 밖에서 끝난 끌기는 ProseMirror가 정리하지 못하므로 여기서 비운다.
    editor.view.dragging = null;
  };

  return (
    <div className="block-handle" style={{ top: place.top, left: place.left }} aria-hidden="true">
      {/* 마우스로 누를 때 편집 영역의 포커스를 빼앗지 않게 한다. */}
      <button type="button" tabIndex={-1} title="아래에 블록 추가" onMouseDown={(e) => e.preventDefault()} onClick={addBelow}>
        <Icon name="plus" />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="block-handle-grip"
        title="끌어서 옮기기 (Alt+↑/↓)"
        draggable
        onClick={selectBlock}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <Icon name="grip" />
      </button>
    </div>
  );
}
