import Image from "@tiptap/extension-image";

/** 첨부 이미지를 내주는 자체 프로토콜 주소(D-17). */
const ASSET_ORIGIN = "http://wyasset.localhost/";

/** 이미지 노드에 넣을 수 있는 첨부 파일 이름인가. 경로·주소는 받지 않는다. */
function isAssetName(name: unknown): name is string {
  return typeof name === "string" && /^[^\\/:?#]+$/.test(name) && name !== "." && name !== "..";
}

export function assetUrl(name: string): string {
  return ASSET_ORIGIN + encodeURIComponent(name);
}

/** 붙여넣은 HTML의 img src에서 첨부 파일 이름을 꺼낸다. 첨부 주소가 아니면 null. */
function assetNameFromUrl(src: string | null): string | null {
  if (!src?.startsWith(ASSET_ORIGIN)) return null;
  try {
    const name = decodeURIComponent(src.slice(ASSET_ORIGIN.length));
    return isAssetName(name) ? name : null;
  } catch {
    return null;
  }
}

const altText = (alt: unknown) => (typeof alt === "string" && alt) || "첨부 이미지";

/**
 * 이미지 블록(F-02.6). JSON의 src에는 첨부 파일 이름만 두고(D-17), 화면에 그릴 때만 wyasset 주소로 바꾼다.
 * 외부 주소 이미지는 받지 않는다. 그리면 네트워크 요청이 나가기 때문이다(NF-06).
 */
export const WyImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => assetNameFromUrl(el.getAttribute("src")),
        renderHTML: (attrs: Record<string, unknown>) => (isAssetName(attrs.src) ? { src: assetUrl(attrs.src) } : {}),
      },
      alt: {
        default: null,
        renderHTML: (attrs: Record<string, unknown>) => ({ alt: altText(attrs.alt) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]", getAttrs: (el: HTMLElement) => (assetNameFromUrl(el.getAttribute("src")) ? null : false) }];
  },
  // `![](주소)` 입력으로 외부 주소 이미지가 생기지 않게 한다.
  addInputRules() {
    return [];
  },
  // 첨부 파일이 없으면 깨진 그림 대신 파일 이름을 알리는 상자를 보인다(S-06).
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "editor-image";
      const name = node.attrs.src as unknown;
      const showMissing = () => {
        dom.replaceChildren();
        dom.classList.add("is-missing");
        dom.textContent = `이미지 파일을 찾을 수 없습니다: ${typeof name === "string" ? name : ""}`;
      };
      if (isAssetName(name)) {
        const img = document.createElement("img");
        img.src = assetUrl(name);
        img.alt = altText(node.attrs.alt);
        img.draggable = false;
        img.addEventListener("error", showMissing, { once: true });
        dom.append(img);
      } else {
        showMissing();
      }
      return { dom };
    };
  },
});

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
