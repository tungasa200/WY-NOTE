import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

/** 커서가 든 표의 시작 위치. 편집 영역에 포커스가 없거나 표 밖이면 null. */
function cursorTable(editor: Editor): number | null {
  if (!editor.view.hasFocus()) return null;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return $from.before(d);
  return null;
}

/**
 * 표 수정 도구(행·열 추가·삭제, 표 삭제). 커서가 표 안에 있을 때만 표 바로 아래에 띄운다.
 * 버튼을 눌러도 편집 영역의 포커스·선택은 그대로 둔다(누를 때 포커스를 빼앗지 않는다).
 */
export function TableTools({ editor, wrapRef }: { editor: Editor; wrapRef: RefObject<HTMLDivElement | null> }) {
  const table = useEditorState({ editor, selector: ({ editor: e }) => cursorTable(e) });
  // 문서가 바뀌면(행 추가 등) 표 높이가 바뀌므로 자리를 다시 잰다.
  const doc = useEditorState({ editor, selector: ({ editor: e }) => e.state.doc });
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  // 창 폭이 바뀌면 본문이 가운데로 다시 놓이므로 다시 잰다.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const resize = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    resize.observe(wrap);
    return () => resize.disconnect();
  }, [wrapRef]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = table === null ? null : editor.view.nodeDOM(table);
    if (!wrap || !(el instanceof HTMLElement)) {
      setPlace(null);
      return;
    }
    const box = el.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    setPlace({ top: box.bottom - wrapBox.top + 4, left: box.left - wrapBox.left });
  }, [editor, wrapRef, table, doc, width]);

  if (table === null || !place) return null;

  const run = () => editor.chain().focus();
  const tools = [
    { label: "행 추가", act: () => run().addRowAfter().run() },
    { label: "행 삭제", act: () => run().deleteRow().run() },
    { label: "열 추가", act: () => run().addColumnAfter().run() },
    { label: "열 삭제", act: () => run().deleteColumn().run() },
    { label: "표 삭제", act: () => run().deleteTable().run() },
  ];
  return (
    <div className="table-tools" role="toolbar" aria-label="표 수정" style={place}>
      {tools.map(({ label, act }) => (
        <button key={label} type="button" className="editor-button" onMouseDown={(e) => e.preventDefault()} onClick={act}>
          {label}
        </button>
      ))}
    </div>
  );
}
