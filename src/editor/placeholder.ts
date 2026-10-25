import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const TEXT = "/를 입력해 블록 종류를 고르세요";

/** 커서가 있는 빈 문단에만 자리표시를 보인다(S-06). 글자는 CSS가 data-placeholder에서 그린다. */
export const EmptyParagraphHint = Extension.create({
  name: "emptyParagraphHint",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const { selection } = state;
            const { $from } = selection;
            const node = $from.parent;
            if (!selection.empty || !editor.isFocused || !editor.isEditable) return null;
            // 최상위 문단만. 표 칸·목록 안의 빈 줄마다 안내가 뜨면 시끄럽다.
            if (node.type.name !== "paragraph" || node.content.size > 0 || $from.depth !== 1) return null;
            const pos = $from.before();
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: "is-empty-hint", "data-placeholder": TEXT }),
            ]);
          },
        },
      }),
    ];
  },
});
