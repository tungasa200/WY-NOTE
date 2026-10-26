import { Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { dataUrlToFile, isAssetUrl } from "./image";

/** 붙여넣은 HTML에서 걷어 낸 이미지. */
export type PastedImages = {
  /** 넣지 않은 외부 이미지 수(http·file 등 첨부 주소도 data:도 아닌 것) */
  remote: number;
  /** data: 이미지를 파일로 바꾼 것. 첨부로 저장해 넣는다. */
  files: File[];
};

type PasteGuardOptions = {
  /** 붙여넣기·끌어 놓기가 문서에 들어간 뒤 한 번 부른다. 걷어 낸 이미지가 없으면 부르지 않는다. */
  onPasted: (editor: Editor, images: PastedImages) => void;
};

/**
 * 붙여넣기 거르기(사용자 결정, NF-06).
 * - 붙여넣은 HTML의 외부 이미지는 넣지 않고 그 수를 알린다. 그리면 네트워크 요청이 나가기 때문이다.
 * - data: 이미지는 파일로 바꿔 첨부로 저장한다. 붙여넣은 내용 뒤(붙여넣은 뒤의 커서 자리)에 들어간다.
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
    let pending: PastedImages | null = null;
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
            const images: PastedImages = { remote: 0, files: [] };
            for (const img of Array.from(doc.querySelectorAll("img"))) {
              const src = img.getAttribute("src") ?? "";
              if (isAssetUrl(src)) continue;
              if (/^data:/i.test(src)) {
                const file = dataUrlToFile(src);
                if (file) images.files.push(file);
                else images.remote += 1;
              } else {
                images.remote += 1;
              }
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
        appendTransaction(trs) {
          if (!pending) return null;
          const ui = trs.map((tr) => tr.getMeta("uiEvent"));
          if (!ui.includes("paste") && !ui.includes("drop")) return null;
          const images = pending;
          pending = null;
          // 트랜잭션 처리 중에 다른 트랜잭션을 보내지 않게 한 박자 뒤에 넣는다.
          queueMicrotask(() => {
            if (!editor.isDestroyed) options.onPasted(editor, images);
          });
          return null;
        },
      }),
    ];
  },
});
