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

/** 첨부 이미지 주소(wyasset)인가. */
export const isAssetUrl = (src: string | null) => assetNameFromUrl(src) !== null;

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

/** 넣을 수 있는 이미지 형식. SVG는 스크립트가 들어갈 수 있어 뺀다(사용자 결정). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** 이미지 하나의 크기 상한 20MB(사용자 결정). Rust 쪽 검사와 같은 값이어야 한다. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** 저장할 파일 확장자(save_attachment의 x-ext). IMAGE_TYPES가 아니면 "bin"이라 Rust가 UnsupportedType으로 거절한다. */
export const imageExt = (type: string) => EXTENSIONS[type] ?? "bin";

/**
 * `data:` 주소를 파일로 바꾼다. 네트워크 요청 없이 문자열만 푼다(fetch는 CSP connect-src에 막힌다).
 * 형식은 거르지 않는다. 허용 밖 형식도 파일로 돌려주어 넣는 쪽이 이유를 알리게 한다. 주소가 깨졌으면 null.
 */
export function dataUrlToFile(url: string): File | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!match) return null;
  const type = match[1].toLowerCase() || "text/plain";
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    if (/;base64/i.test(match[2])) {
      const bin = atob(match[3].replace(/\s/g, ""));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
    }
    return new File([bytes], `붙여넣은 이미지.${imageExt(type)}`, { type });
  } catch {
    return null;
  }
}
