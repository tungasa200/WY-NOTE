import { useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { separator: true }
  | { separator?: false; label: string; keys?: string; danger?: boolean; onSelect: () => void };

type Props = {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  /** restoreFocus: Esc·바깥 클릭처럼 아무것도 고르지 않고 닫혔으면 true(여는 데 쓴 행으로 포커스를 돌린다). */
  onClose: (restoreFocus: boolean) => void;
};

export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 창 밖으로 넘치면 안쪽으로 당기고, 첫 항목에 포커스.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  const buttons = () => [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  return (
    <div
      className="menu-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose(true);
      }}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        aria-label={label}
        style={pos}
        onKeyDown={(e) => {
          const list = buttons();
          const i = list.indexOf(document.activeElement as HTMLElement);
          if (e.key === "ArrowDown") list[(i + 1) % list.length].focus();
          else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length].focus();
          else if (e.key === "Home") list[0].focus();
          else if (e.key === "End") list[list.length - 1].focus();
          else if (e.key === "Escape" || e.key === "Tab") onClose(true);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu-separator" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              data-danger={item.danger || undefined}
              aria-keyshortcuts={item.keys === "Del" ? "Delete" : item.keys}
              onClick={() => {
                onClose(false);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.keys && <kbd>{item.keys}</kbd>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
