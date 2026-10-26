// 편집 영역의 한 페이지: 제목 + 편집기(화면설계 S-06). 편집기는 Editor의 props(content, onChange, onImageUpload)만 쓴다.
import { useRef } from "react";
import { api } from "../api";
import { Editor, type EditorInstance } from "../editor/Editor";
import { imageExt } from "../editor/image";
import type { JSONContent, Page } from "../lib/db-types";

/** 편집 영역에 연 페이지. 이름은 트리가 원본이라 본문만 든다. */
export type OpenPage = Pick<Page, "id" | "content">;

type Props = {
  page: OpenPage;
  /** 트리와 같은 값(이름은 트리 목록이 원본). */
  title: string;
  /** 새로 만든 페이지면 제목에 커서를 둔다(F-01.1). */
  focusTitle: boolean;
  onTitleChange: (title: string) => void;
  onContentChange: (doc: JSONContent) => void;
  onEditor?: (editor: EditorInstance, attached: boolean) => void;
  onNotify?: (message: string) => void;
};

export function PageView({ page, title, focusTitle, onTitleChange, onContentChange, onEditor, onNotify }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // 이미지를 이 페이지의 첨부로 저장하고 파일 이름을 받는다(F-02.6). 형식·크기는 편집기가 먼저 거른다(P3-5).
  const uploadImage = async (file: File) =>
    (await api.saveAttachment(page.id, imageExt(file.type), new Uint8Array(await file.arrayBuffer()))).fileName;

  return (
    <article className="page">
      {/* 긴 제목도 다 보이도록 줄바꿈되는 textarea. 제목은 한 줄 값이라 붙여 넣은 줄바꿈은 공백으로 바꾼다. */}
      <textarea
        // 제목에 커서를 둘 때는 편집기 autofocus를 끈다(둘이 포커스를 다투지 않게).
        autoFocus={focusTitle}
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
        <Editor
          content={page.content}
          onChange={onContentChange}
          autofocus={focusTitle ? false : "end"}
          onEditor={onEditor}
          onNotify={onNotify}
          onImageUpload={uploadImage}
        />
      </div>
    </article>
  );
}
