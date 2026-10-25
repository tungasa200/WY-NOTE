import { Extension } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type Command } from "@tiptap/pm/state";

/** 이 노드 안의 자식들끼리 순서를 바꾼다. 목록 안에서는 항목 단위로 옮긴다. */
const CONTAINERS = new Set(["doc", "bulletList", "orderedList", "taskList"]);

/** 선택이 들어 있는 블록을 위(-1)·아래(1)로 한 칸 옮긴다. 트랜잭션 하나라 실행 취소 한 번에 되돌아간다. */
function moveBlock(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { selection } = state;
    const { $from, $to } = selection;
    let block: PMNode | null = null;
    let parent: PMNode | null = null;
    let start = 0;
    let index = 0;

    if (selection instanceof NodeSelection && CONTAINERS.has($from.parent.type.name)) {
      block = selection.node;
      parent = $from.parent;
      start = selection.from;
      index = $from.index();
    } else {
      for (let d = $from.depth; d > 0; d--) {
        if (CONTAINERS.has($from.node(d - 1).type.name)) {
          block = $from.node(d);
          parent = $from.node(d - 1);
          start = $from.before(d);
          index = $from.index(d - 1);
          break;
        }
      }
    }
    if (!block || !parent) return false;
    // 여러 블록에 걸친 선택은 옮기지 않는다.
    if ($to.pos > start + block.nodeSize) return false;
    const target = index + dir;
    if (target < 0 || target >= parent.childCount) return true; // 끝에서는 아무것도 하지 않고 키만 소비한다.
    if (!dispatch) return true;

    const sibling = parent.child(target);
    const tr = state.tr;
    let newStart: number;
    if (dir < 0) {
      const from = start - sibling.nodeSize;
      tr.replaceWith(from, start + block.nodeSize, [block, sibling]);
      newStart = from;
    } else {
      tr.replaceWith(start, start + block.nodeSize + sibling.nodeSize, [sibling, block]);
      newStart = start + sibling.nodeSize;
    }
    const delta = newStart - start;
    if (selection instanceof NodeSelection) {
      tr.setSelection(NodeSelection.create(tr.doc, selection.from + delta));
    } else if (selection instanceof TextSelection) {
      tr.setSelection(TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta));
    } else {
      tr.setSelection(Selection.near(tr.doc.resolve(selection.from + delta)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Alt+↑/↓ 블록 이동(F-02.7). */
export const BlockMove = Extension.create({
  name: "blockMove",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": ({ editor }) => moveBlock(-1)(editor.state, editor.view.dispatch),
      "Alt-ArrowDown": ({ editor }) => moveBlock(1)(editor.state, editor.view.dispatch),
    };
  },
});
