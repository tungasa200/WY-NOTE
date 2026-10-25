// 편집 영역의 한 페이지: 제목 + 편집기(화면설계 S-06). 편집기는 Editor의 props(content, onChange)만 쓴다.
import { useEffect, useRef } from "react";
import { Editor } from "../editor/Editor";
import type { JSONContent, Page } from "../lib/db-types";

type Props = {
  page: Page;
  /** 트리와 같은 값(이름은 트리 목록이 원본). */
  title: string;
  /** 새로 만든 페이지면 제목에 커서를 둔다(F-01.1). */
  focusTitle: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (doc: JSONContent) => void;
};

export function PageView({ page, title, focusTitle, onTitleChange, onContentChange }: Props) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    // 편집기의 autofocus가 먼저 돌고 난 뒤에 제목으로 가져온다.
    const t = setTimeout(() => titleRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [focusTitle]);

  return (
    <article className="page">
      {/* 긴 제목도 다 보이도록 줄바꿈되는 textarea. 제목은 한 줄 값이라 붙여 넣은 줄바꿈은 공백으로 바꾼다. */}
      <textarea
        ref={titleRef}
        className="page-title"
        aria-label="페이지 제목"
        placeholder="제목 없음"
        rows={1}
        value={title}
        onChange={(e) => onTitleChange(e.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={(e) => {
          // 제목에서 Enter는 본문 첫 블록으로(S-06).
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            bodyRef.current?.querySelector<HTMLElement>(".editor-body")?.focus();
          }
        }}
      />
      <div ref={bodyRef} className="page-body">
        <Editor content={page.content} onChange={onContentChange} />
      </div>
    </article>
  );
}
