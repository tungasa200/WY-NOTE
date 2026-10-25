// 페이지 트리(F-01~F-01.4, 화면설계 S-02). 평평한 treeitem 목록 + aria-level 방식.
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import type { PageId } from "../lib/db-types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { descendantIds, displayTitle, dropTarget, visibleRows, type DropZone, type TreeIndex } from "./tree";
import "./PageTree.css";

export type PageTreeHandle = {
  /** 그 행에(보이지 않으면 Tab 진입 행에) 포커스를 둔다. */
  focus: (id: PageId | null) => void;
};

type Props = {
  ref?: Ref<PageTreeHandle>;
  ix: TreeIndex;
  /** 지금 열린 페이지. 휴지통·설정 화면이 열려 있으면 null(강조를 끈다). */
  selectedId: PageId | null;
  onOpen: (id: PageId) => void;
  onCreate: (parentId: PageId | null) => void;
  onRename: (id: PageId, title: string) => void;
  onToggle: (id: PageId, expanded: boolean) => void;
  onTrash: (id: PageId) => void;
  onMove: (id: PageId, newParentId: PageId | null, newPosition: number) => void;
};

const HOVER_EXPAND_MS = 600;

export function PageTree({ ref, ix, selectedId, onOpen, onCreate, onRename, onToggle, onTrash, onMove }: Props) {
  const rows = useMemo(() => visibleRows(ix), [ix]);
  const [focusedId, setFocusedId] = useState<PageId | null>(null);
  const [renamingId, setRenamingId] = useState<PageId | null>(null);
  const [menu, setMenu] = useState<{ id: PageId; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: PageId; blocked: Set<PageId> } | null>(null);
  const [drop, setDrop] = useState<{ id: PageId; zone: DropZone } | null>(null);
  const hoverTimer = useRef<{ id: PageId; timer: ReturnType<typeof setTimeout> } | null>(null);
  const rowEls = useRef(new Map<PageId, HTMLDivElement>());
  const pendingFocus = useRef<PageId | null>(null);

  // 포커스 행이 사라지면(휴지통·접힘) 열린 페이지나 첫 행이 Tab 진입점이 된다.
  const tabStop = rows.some((r) => r.node.id === focusedId)
    ? focusedId
    : rows.some((r) => r.node.id === selectedId)
      ? selectedId
      : (rows[0]?.node.id ?? null);

  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    rowEls.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  useEffect(() => () => clearHover(), []);

  useImperativeHandle(ref, () => ({
    focus: (id) => rowEls.current.get(id !== null && rowEls.current.has(id) ? id : (tabStop ?? -1))?.focus(),
  }));

  const focusRow = (id: PageId) => {
    setFocusedId(id);
    pendingFocus.current = id;
  };

  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current.timer);
    hoverTimer.current = null;
  };

  const endDrag = () => {
    clearHover();
    setDrag(null);
    setDrop(null);
  };

  const menuItems = (id: PageId): MenuItem[] => [
    { label: "하위 페이지 추가", onSelect: () => onCreate(id) },
    { label: "이름 바꾸기", keys: "F2", onSelect: () => setRenamingId(id) },
    { separator: true },
    { label: "휴지통으로 이동", keys: "Del", danger: true, onSelect: () => onTrash(id) },
  ];

  const openMenuAtRow = (id: PageId) => {
    const r = rowEls.current.get(id)?.getBoundingClientRect();
    if (r) setMenu({ id, x: r.left + 24, y: r.bottom });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (renamingId !== null) return;
    const { node, hasChildren } = rows[index];
    const move = (i: number) => rows[i] && focusRow(rows[i].node.id);
    const key = e.shiftKey && e.key === "F10" ? "ContextMenu" : e.key;
    switch (key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (hasChildren && !node.expanded) onToggle(node.id, true);
        else if (hasChildren) move(index + 1);
        break;
      case "ArrowLeft":
        if (hasChildren && node.expanded) onToggle(node.id, false);
        else if (node.parentId !== null) focusRow(node.parentId);
        break;
      case "Enter":
        onOpen(node.id);
        break;
      case "F2":
        setRenamingId(node.id);
        break;
      case "Delete":
        onTrash(node.id);
        break;
      case "ContextMenu":
        openMenuAtRow(node.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, id: PageId, hasChildren: boolean, expanded: boolean) => {
    if (!drag) return;
    // 자기 자신과 자기 하위로는 놓을 수 없다: 기본 동작(놓기 금지 커서)을 그대로 둔다.
    if (drag.blocked.has(id)) {
      setDrop(null);
      clearHover();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const zone: DropZone = y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
    if (drop?.id !== id || drop.zone !== zone) setDrop({ id, zone });
    // 접힌 행 위에 0.6초 머물면 펼친다.
    if (zone === "inside" && hasChildren && !expanded) {
      if (hoverTimer.current?.id !== id) {
        clearHover();
        hoverTimer.current = { id, timer: setTimeout(() => onToggle(id, true), HOVER_EXPAND_MS) };
      }
    } else clearHover();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (drag && drop) {
      const { newParentId, newPosition } = dropTarget(ix, drag.id, drop.id, drop.zone);
      onMove(drag.id, newParentId, newPosition);
    }
    endDrag();
  };

  if (rows.length === 0) return <p className="tree-empty">아직 페이지가 없습니다.</p>;

  return (
    <>
      <div
        className="tree"
        role="tree"
        aria-label="페이지"
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
      >
        {rows.map(({ node, depth, hasChildren }, index) => {
          const selected = node.id === selectedId;
          const title = displayTitle(node.title);
          const dropZone = drop?.id === node.id ? drop.zone : undefined;
          return (
            <div
              key={node.id}
              ref={(el) => {
                if (el) rowEls.current.set(node.id, el);
                else rowEls.current.delete(node.id);
              }}
              data-page-id={node.id}
              className="tree-row"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected}
              aria-expanded={hasChildren ? node.expanded : undefined}
              data-dragging={drag?.id === node.id || undefined}
              data-drop={dropZone}
              tabIndex={node.id === tabStop ? 0 : -1}
              style={{ "--depth": depth } as CSSProperties}
              draggable={renamingId !== node.id}
              onFocus={() => setFocusedId(node.id)}
              onClick={() => onOpen(node.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              onContextMenu={(e) => {
                e.preventDefault();
                setFocusedId(node.id);
                setMenu({ id: node.id, x: e.clientX, y: e.clientY });
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", title);
                setDrag({ id: node.id, blocked: new Set([node.id, ...descendantIds(ix, node.id)]) });
              }}
              onDragOver={(e) => onDragOver(e, node.id, hasChildren, node.expanded)}
              onDrop={onDrop}
              onDragEnd={endDrag}
            >
              <span
                className="tree-twisty"
                aria-hidden="true"
                data-open={node.expanded || undefined}
                onClick={(e) => {
                  if (!hasChildren) return;
                  e.stopPropagation();
                  onToggle(node.id, !node.expanded);
                }}
              >
                {hasChildren ? "▸" : ""}
              </span>
              {renamingId === node.id ? (
                <RenameInput
                  initial={node.title}
                  onDone={(value) => {
                    setRenamingId(null);
                    if (value !== null && value !== node.title) onRename(node.id, value);
                    focusRow(node.id);
                  }}
                />
              ) : (
                <span className="tree-title" data-untitled={!node.title.trim() || undefined} title={title}>
                  {title}
                </span>
              )}
              {/* 마우스용 바로가기. 키보드는 Shift+F10 메뉴와 단축키로 같은 일을 한다. */}
              <span className="tree-actions" aria-hidden="true">
                <button
                  type="button"
                  tabIndex={-1}
                  title="메뉴"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ id: node.id, x: r.left, y: r.bottom });
                  }}
                >
                  ⋯
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  title="하위 페이지 추가"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreate(node.id);
                  }}
                >
                  +
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${displayTitle(ix.byId.get(menu.id)?.title ?? "")} 메뉴`}
          items={menuItems(menu.id)}
          onClose={(restoreFocus) => {
            const id = menu.id;
            setMenu(null);
            if (restoreFocus) focusRow(id);
          }}
        />
      )}
    </>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="tree-rename"
      aria-label="페이지 이름"
      placeholder="제목 없음"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}
