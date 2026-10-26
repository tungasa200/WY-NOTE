import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Icon } from "./icons";

type Open = { href: string; x: number; y: number };

const MENU_WIDTH = 160;
const MENU_HEIGHT = 40;

/**
 * 노트 안 링크(사용자 결정, D-18): 눌러도 열지 않고 오른쪽 클릭 메뉴에 "링크 복사"만 둔다.
 * 링크가 아닌 곳의 오른쪽 클릭은 WebView 기본 메뉴(맞춤법·복사·붙여넣기)를 그대로 둔다.
 * 기본 메뉴를 링크 위에서 띄우면 "새 창에서 열기"가 있어 링크 위에서만 이 메뉴로 바꾼다.
 */
export function useLinkMenu(editor: Editor, onStatus: (message: string) => void) {
  const [open, setOpen] = useState<Open | null>(null);

  const onContextMenu = (e: MouseEvent) => {
    const anchor = (e.target as Element).closest?.("a[href]");
    let href = anchor?.getAttribute("href") ?? null;
    let { clientX: x, clientY: y } = e;
    // 메뉴 키·Shift+F10(button 0)은 마우스 자리가 없으니 커서가 링크 안이면 커서 아래에 띄운다.
    if (!anchor && e.button === 0 && editor.isActive("link")) {
      href = (editor.getAttributes("link").href as string | undefined) ?? null;
      const at = editor.view.coordsAtPos(editor.state.selection.from);
      x = at.left;
      y = at.bottom;
    }
    if (!href) return;
    e.preventDefault();
    setOpen({
      href,
      x: Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH)),
      y: Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT)),
    });
  };

  // 링크는 클릭(Ctrl·가운데 버튼 포함)으로 이동하지 않는다. 커서는 mousedown에서 놓이므로 click을 막아도 편집은 된다.
  const onClickCapture = (e: MouseEvent) => {
    if ((e.target as Element).closest?.("a[href]")) e.preventDefault();
  };

  const menu = open && (
    <LinkMenu
      {...open}
      onClose={(refocus) => {
        setOpen(null);
        if (refocus) editor.view.focus();
      }}
      onStatus={onStatus}
    />
  );

  // 링크 주소 툴팁(S-06). ProseMirror가 그리는 a에 title을 달면 그 변경을 편집으로 읽으므로 바깥 틀에 단다.
  const onMouseOver = (e: MouseEvent<HTMLElement>) => {
    const href = (e.target as Element).closest?.("a[href]")?.getAttribute("href") ?? "";
    if (e.currentTarget.title !== href) e.currentTarget.title = href;
  };

  return { onContextMenu, onClickCapture, onAuxClick: onClickCapture, onMouseOver, menu };
}

function LinkMenu({
  href,
  x,
  y,
  onClose,
  onStatus,
}: Open & { onClose: (refocus: boolean) => void; onStatus: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // 바깥이 다시 그려져도 포커스를 다시 옮기지 않게 effect는 열릴 때 한 번만 돈다.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    // 메뉴 밖을 누르면 닫는다. 그 자리로 포커스가 가도록 빼앗지 않는다.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current(false);
    };
    const onScroll = () => closeRef.current(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onScroll);
    };
  }, []);

  const copy = async () => {
    onClose(true);
    try {
      await navigator.clipboard.writeText(href);
      onStatus("링크를 복사했습니다");
    } catch {
      onStatus("링크를 복사하지 못했습니다.");
    }
  };

  return (
    <div
      ref={ref}
      className="link-menu"
      role="menu"
      aria-label="링크"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose(true);
        }
      }}
    >
      <button type="button" role="menuitem" className="link-menu-item" onClick={copy}>
        <Icon name="link" />
        링크 복사
      </button>
    </div>
  );
}
