import { Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { assetUrl, dataUrlToFile, isAssetUrl } from "./image";

/** 붙여넣은 HTML에서 걷어 낸 이미지. */
export type PastedImages = {
  /** 넣지 않은 외부 이미지 수(http·file 등 첨부 주소도 data:도 아닌 것) */
  remote: number;
  /** data: 이미지를 파일로 바꾼 것. 첨부로 저장해 넣는다. */
  files: File[];
  /** files[i]를 넣을 자리(붙여넣은 HTML에서 그 이미지가 있던 곳). 자리를 잃었으면 undefined. */
  spots: (number | undefined)[];
};

type PasteGuardOptions = {
  /** 붙여넣기·끌어 놓기가 문서에 들어간 뒤 한 번 부른다. 걷어 낸 이미지가 없으면 부르지 않는다. */
  onPasted: (editor: Editor, images: PastedImages) => void;
};

/**
 * 붙여넣기 거르기(사용자 결정, NF-06).
 * - 붙여넣은 HTML의 외부 이미지는 넣지 않고 그 수를 알린다. 그리면 네트워크 요청이 나가기 때문이다.
 * - data: 이미지는 파일로 바꿔 첨부로 저장한다. 그 이미지가 있던 자리에 들어간다:
 *   img를 첨부 주소 모양의 표지로 바꿔 두면 이미지 노드로 읽힌다. 붙여넣은 트랜잭션 뒤에 그 노드를 지우며 자리를 얻는다.
 * - Ctrl+Shift+V는 서식 없이 글만 붙여 넣는다. 글 서식은 ProseMirror가 Shift를 보고 이미 빼므로,
 *   여기서는 함께 실린 이미지 파일을 넣지 않게만 한다.
 */
export const PasteGuard = Extension.create<PasteGuardOptions>({
  name: "pasteGuard",
  // 파일 붙여넣기(FileHandler, 100)보다 먼저 Ctrl+Shift+V를 본다.
  priority: 110,
  addOptions() {
    return { onPasted: () => {} };
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    // transformPastedHTML은 FileHandler가 붙여넣기를 가로채기 전에도 불리므로, 걷어 낸 것을 바로 처리하지 않고
    // 붙여넣기가 실제로 문서에 들어간 트랜잭션에서 처리한다.
    let pending: (Omit<PastedImages, "spots"> & { marker: string }) | null = null;
    let pasteCount = 0;
    let plainPaste = false;
    const reset = () => {
      pending = null;
      return false;
    };
    return [
      new Plugin({
        key: new PluginKey("pasteGuard"),
        props: {
          handleKeyDown(_view, event) {
            plainPaste = (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyV";
            return false;
          },
          handleDOMEvents: { paste: reset, drop: reset },
          transformPastedHTML(html) {
            if (!/<img/i.test(html)) return html;
            const doc = new DOMParser().parseFromString(html, "text/html");
            // 붙여넣기마다 다른 표지. 문서에 들어간 트랜잭션에서 바로 지운다.
            const images = { remote: 0, files: [] as File[], marker: `wy-paste-${Date.now()}-${++pasteCount}-` };
            for (const img of Array.from(doc.querySelectorAll("img"))) {
              const src = img.getAttribute("src") ?? "";
              if (isAssetUrl(src)) continue;
              const file = /^data:/i.test(src) ? dataUrlToFile(src) : null;
              if (file) {
                img.setAttribute("src", assetUrl(images.marker + images.files.length));
                images.files.push(file);
                continue;
              }
              images.remote += 1;
              img.remove();
            }
            pending = images.remote || images.files.length ? images : null;
            return pending ? doc.body.innerHTML : html;
          },
          handlePaste(view, event) {
            // pasteText·pasteHTML이 만든 가짜 이벤트에는 clipboardData가 없다.
            if (!plainPaste || !event.clipboardData) return false;
            plainPaste = false;
            if (!event.clipboardData.files.length) return false; // 글만 있으면 ProseMirror가 서식 없이 넣는다.
            const text = event.clipboardData.getData("text/plain");
            if (text) view.pasteText(text);
            return true;
          },
        },
        appendTransaction(trs, _old, state) {
          if (!pending || !trs.some((tr) => tr.docChanged)) return null;
          const { marker, ...rest } = pending;
          const found: { index: number; pos: number }[] = [];
          // 이미지는 블록이라 글 블록 안은 보지 않는다.
          state.doc.descendants((node, pos) => {
            const src: unknown = node.type.name === "image" ? node.attrs.src : null;
            if (typeof src === "string" && src.startsWith(marker)) found.push({ index: Number(src.slice(marker.length)), pos });
            return !node.isTextblock;
          });
          // 붙여넣기는 그 뒤 첫 문서 변경에 들어오거나 들어오지 않는다(가로채였을 때). 어느 쪽이든 여기서 끝낸다.
          // 표 붙여넣기(prosemirror-tables)처럼 uiEvent 없이 들어오는 것도 표지가 보이면 처리한다.
          pending = null;
          const ui = trs.map((tr) => tr.getMeta("uiEvent"));
          if (!found.length && !ui.includes("paste") && !ui.includes("drop")) return null;
          // 표지 노드를 지우고 그 자리를 기억한다. 뒤에서부터 지워 앞 노드의 위치가 그대로이게 한다.
          found.reverse();
          const tr = state.tr;
          for (const { pos } of found) tr.delete(pos, pos + state.doc.nodeAt(pos)!.nodeSize);
          // 지운 노드의 시작은 제 삭제로는 그대로이고, 더 앞의 삭제만큼 당겨진다(삭제가 단계를 몇 개 만들든 맞다).
          const spots = rest.files.map((): number | undefined => undefined);
          for (const { index, pos } of found) spots[index] = tr.mapping.map(pos, -1);
          const images: PastedImages = { ...rest, spots };
          // 트랜잭션 처리 중에 다른 트랜잭션을 보내지 않게 한 박자 뒤에 넣는다.
          queueMicrotask(() => {
            if (!editor.isDestroyed) options.onPasted(editor, images);
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
