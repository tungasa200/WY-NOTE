// list_tree가 주는 평평한 목록으로 트리 계산을 한다(계약 8절: 트리·경로·하위 수는 화면이 계산).
import type { PageId, TreeNode } from "../lib/db-types";

export type TreeIndex = {
  byId: Map<PageId, TreeNode>;
  children: Map<PageId | null, TreeNode[]>;
};

export function indexTree(nodes: TreeNode[]): TreeIndex {
  const byId = new Map<PageId, TreeNode>();
  const children = new Map<PageId | null, TreeNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
  return { byId, children };
}

/** 위에서 아래로 조상 목록(자기 자신 제외). */
export function ancestors(ix: TreeIndex, id: PageId): TreeNode[] {
  const out: TreeNode[] = [];
  let p = ix.byId.get(id)?.parentId ?? null;
  while (p !== null) {
    const n = ix.byId.get(p);
    if (!n) break;
    out.unshift(n);
    p = n.parentId;
  }
  return out;
}

export function descendantIds(ix: TreeIndex, id: PageId): PageId[] {
  const out: PageId[] = [];
  const walk = (pid: PageId) =>
    (ix.children.get(pid) ?? []).forEach((c) => {
      out.push(c.id);
      walk(c.id);
    });
  walk(id);
  return out;
}

type VisibleRow = { node: TreeNode; depth: number; hasChildren: boolean };

/** 펼친 항목만 따라가며 화면에 보일 행을 순서대로 만든다. */
export function visibleRows(ix: TreeIndex): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (pid: PageId | null, depth: number) =>
    (ix.children.get(pid) ?? []).forEach((node) => {
      const hasChildren = (ix.children.get(node.id)?.length ?? 0) > 0;
      out.push({ node, depth, hasChildren });
      if (hasChildren && node.expanded) walk(node.id, depth + 1);
    });
  walk(null, 0);
  return out;
}

export const displayTitle = (title: string) => title.trim() || "제목 없음";

export type DropZone = "before" | "after" | "inside";

/** 놓을 위치를 move_page 인자로 바꾼다. newPosition은 옮긴 뒤 새 형제 목록에서의 순서. */
export function dropTarget(ix: TreeIndex, dragId: PageId, targetId: PageId, zone: DropZone) {
  const target = ix.byId.get(targetId)!;
  if (zone === "inside") {
    const kids = (ix.children.get(targetId) ?? []).filter((n) => n.id !== dragId);
    return { newParentId: targetId, newPosition: kids.length };
  }
  const sibs = (ix.children.get(target.parentId) ?? []).filter((n) => n.id !== dragId);
  const i = sibs.findIndex((n) => n.id === targetId);
  return { newParentId: target.parentId, newPosition: zone === "before" ? i : i + 1 };
}
