// 내보낼 페이지 묶음을 export_markdown 인자(docs/계약-AI.md 5.3)로 만든다. 파일 쓰기와 폴더 이름은 Rust가 맡는다.
// scripts/check-markdown.ts가 Node 타입 제거 실행으로 부르므로 다른 모듈은 .ts 확장자로 가져온다.
import type { JSONContent } from "@tiptap/react";
import type { PageId } from "../lib/db-types.ts";
import { docToMarkdown, mergeWarnings, type ExportWarning } from "./markdown.ts";

export type ExportNode = {
  pageId: PageId;
  /** 원래 제목. 파일 이름은 Rust가 만든다 */
  title: string;
  markdown: string;
  children: ExportNode[];
};

export type ExportResult =
  | { cancelled: true }
  | { cancelled: false; dir: string; fileCount: number; imageCount: number; missingImages: string[] };

export type ExportRequest = { root: ExportNode; attachments: string[] };

/** save_attachment가 만드는 첨부 이름 모양. Rust는 이 밖의 이름이 하나라도 있으면 내보내기 전체를 InvalidInput으로 거절한다. */
const ATTACHMENT_NAME = /^\d+\.(png|jpg|jpeg|gif|webp|svg)$/;

export const isAttachmentName = (name: string) => ATTACHMENT_NAME.test(name);

export type ExportSource = {
  /** 하위 페이지(트리 순서). */
  childrenOf(id: PageId): { id: PageId }[];
  /** 저장된 제목·본문. 제목은 트리 대신 여기서 읽어 내보내기 직전 저장한 이름까지 반영한다. */
  getPage(id: PageId): Promise<{ title: string; content: JSONContent }>;
};

export type BuiltExport = {
  request: ExportRequest;
  warnings: ExportWarning[];
  /** 첨부 이름 모양이 아니어서 복사하지 않는 이미지(링크는 남지만 파일이 없다). */
  skippedImages: string[];
};

/**
 * 페이지 묶음을 읽어 마크다운으로 바꾼다. 깊이 d(꼭대기 = 0)의 페이지는 이미지를 `../`×d + `images/`로 가리킨다(계약 5.2).
 * onProgress는 페이지 하나를 바꿀 때마다 (끝낸 수, 전체 수)로 부른다.
 */
export async function buildExport(
  src: ExportSource,
  rootId: PageId,
  includeChildren: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<BuiltExport> {
  const total = includeChildren ? countPages(src, rootId) : 1;
  const images = new Set<string>();
  const warnings: ExportWarning[] = [];
  let done = 0;

  // 형제는 차례로 읽는다: 페이지가 많아도 IPC를 한꺼번에 쏟지 않고 진행 수가 순서대로 오른다.
  const visit = async (id: PageId, depth: number): Promise<ExportNode> => {
    const page = await src.getPage(id);
    const r = docToMarkdown(page.content, { imageDir: "../".repeat(depth) + "images" });
    r.images.forEach((n) => images.add(n));
    warnings.push(...r.warnings);
    done++;
    onProgress?.(done, total);
    const children: ExportNode[] = [];
    if (includeChildren) for (const c of src.childrenOf(id)) children.push(await visit(c.id, depth + 1));
    return { pageId: id, title: page.title, markdown: r.markdown, children };
  };

  const node = await visit(rootId, 0);
  const all = [...images];
  return {
    request: { root: node, attachments: all.filter(isAttachmentName) },
    warnings: mergeWarnings(warnings),
    skippedImages: all.filter((n) => !isAttachmentName(n)),
  };
}

function countPages(src: Pick<ExportSource, "childrenOf">, id: PageId): number {
  return 1 + src.childrenOf(id).reduce((n, c) => n + countPages(src, c.id), 0);
}
