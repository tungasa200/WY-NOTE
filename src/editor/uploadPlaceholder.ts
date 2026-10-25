import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

type Meta = { add: { id: object; pos: number; files: File[] } } | { remove: object };

const key = new PluginKey<DecorationSet>("uploadPlaceholder");

/** 파일마다 회색 상자 하나. 크기를 알기 전에는 기본 높이, 알면 그 이미지와 같은 크기로 바꾼다. */
function render(files: File[]) {
  const dom = document.createElement("div");
  dom.className = "editor-upload-placeholders";
  dom.setAttribute("aria-hidden", "true"); // 진행 상황은 아래 상태 줄이 알린다.
  for (const file of files) {
    const box = document.createElement("div");
    box.className = "editor-upload-placeholder";
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      box.style.width = `min(100%, ${img.naturalWidth}px)`;
      box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      box.style.height = "auto";
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    dom.append(box);
  }
  return dom;
}

/** 붙여넣기·끌어 놓기로 넣는 이미지를 저장하는 동안 그 자리에 보이는 회색 상자(S-06). 문서에는 들어가지 않는다. */
export const UploadPlaceholder = Extension.create({
  name: "uploadPlaceholder",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          // 저장하는 동안의 편집을 따라 자리를 옮긴다.
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(key) as Meta | undefined;
            if (meta && "add" in meta) {
              const { id, pos, files } = meta.add;
              set = set.add(tr.doc, [Decoration.widget(pos, () => render(files), { id, side: -1 })]);
            } else if (meta) {
              set = set.remove(set.find(undefined, undefined, (spec) => spec.id === meta.remove));
            }
            return set;
          },
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});

/** pos에 자리 표시를 두고 그 표지를 돌려준다. */
export function addUploadPlaceholder(view: EditorView, pos: number, files: File[]): object {
  const id = {};
  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos, files } } satisfies Meta).setMeta("addToHistory", false));
  return id;
}

/** 자리 표시를 걷어 내고 그것이 있던(편집을 따라 옮겨진) 위치를 돌려준다. 그 자리가 지워졌으면 undefined. */
export function removeUploadPlaceholder(view: EditorView, id: object): number | undefined {
  const found = key.getState(view.state)?.find(undefined, undefined, (spec) => spec.id === id)[0];
  view.dispatch(view.state.tr.setMeta(key, { remove: id } satisfies Meta).setMeta("addToHistory", false));
  return found?.from;
}
