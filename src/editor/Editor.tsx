import { useEffect, useRef, useState } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor as TiptapEditor,
  type FocusPosition,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import FileHandler from "@tiptap/extension-file-handler";
import TextAlign from "@tiptap/extension-text-align";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { CODE_LANGUAGES, lowlight } from "./lowlight";
import { IMAGE_TYPES, WyImage } from "./image";
import { ImageBatch } from "./imageNotice";
import { BlockMove } from "./blockMove";
import { SlashCommand } from "./slashMenu";
import { BlockHandle } from "./BlockHandle";
import { TableTools } from "./TableTools";
import { Icon, type IconName } from "./icons";
import { EmptyParagraphHint } from "./placeholder";
import { UploadPlaceholder, addUploadPlaceholder, removeUploadPlaceholder } from "./uploadPlaceholder";
import { PasteGuard } from "./paste";
import { useLinkMenu } from "./LinkMenu";
import "highlight.js/styles/github.css";
import "./Editor.css";

/** 빈 문서 기본값(DB 계약과 같은 값). */
export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

export type EditorInstance = TiptapEditor;

type EditorProps = {
  /** 처음 보여 줄 본문(TipTap JSON). 없으면 EMPTY_DOC. */
  content?: JSONContent;
  /** 본문이 바뀔 때마다 editor.getJSON() 결과를 그대로 넘긴다(DB에 저장하는 형식). 저장 연결은 아직 없다. */
  onChange?: (doc: JSONContent) => void;
  /**
   * 이미지 파일을 첨부 폴더에 저장하고 저장된 파일 이름을 돌려준다(F-02.6, D-17).
   * 이미지 노드의 src에는 이 파일 이름만 들어간다. 없으면 이미지를 넣을 수 없다.
   */
  onImageUpload?: (file: File) => Promise<string>;
  /**
   * 처음 만들 때 커서를 둘 곳. 기본 "end"(본문 끝). 페이지 제목에 커서를 둘 때는 false.
   * 만들 때 한 번만 읽는다.
   */
  autofocus?: FocusPosition;
  /** 편집기가 붙으면 (editor, true), 떨어지면 (editor, false). AI 패널이 선택·본문을 읽는다. */
  onEditor?: (editor: TiptapEditor, attached: boolean) => void;
  /** 알림 문구(S-13). 앱 토스트로 띄운다. */
  onNotify?: (message: string) => void;
};

type ImageHandlers = {
  /**
   * pos: 넣을 자리. 배열이면 files[i]의 자리(없는 칸은 커서 자리). 없으면 커서 자리.
   * remote: 붙여넣기에서 뺀 외부 이미지 수. 같은 알림에 합친다(S-13).
   */
  insert: (editor: TiptapEditor, files: File[], pos?: number | (number | undefined)[], remote?: number) => void;
  canInsert: () => boolean;
  pick: () => void;
};

// 렌더마다 새로 만들면 useEditor가 옵션이 바뀐 것으로 보고 setOptions를 다시 부르므로 편집기마다 한 번만 만든다.
// 바뀔 수 있는 값(콜백)은 handlers 안에서 ref로 읽는다.
const createExtensions = (handlers: ImageHandlers) => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: false,
    // 링크는 보존하되 클릭으로 WebView가 외부 주소로 이동하지 않게 한다(NF-06).
    link: { openOnClick: false },
    // 블록을 끌 때 놓일 자리를 보여 준다.
    dropcursor: { color: "var(--color-drop-indicator)", width: 2 },
  }),
  TaskList,
  TaskItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: (node, checked) => `${checked ? "완료" : "할 일"}: ${node.textContent || "빈 항목"}`,
    },
  }),
  // 열이 많아도 셀이 뭉개지지 않게 최소 너비를 두고, 넘치면 표만 가로로 스크롤한다.
  TableKit.configure({ table: { resizable: false, cellMinWidth: 80 } }),
  // Tab은 2칸(S-06).
  // 문단·제목 정렬. 단축키는 확장 기본값(Ctrl+Shift+L/E/R/J).
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true, tabSize: 2 }),
  WyImage,
  // 형식은 여기서 거르지 않는다. 허용 밖 파일도 받아서 넣지 않은 이유를 알린다(ImageBatch.check).
  FileHandler.configure({
    // 붙여넣은 파일을 다른 붙여넣기 처리가 한 번 더 넣지 않게 한다.
    consumePasteEvent: true,
    onPaste: (editor, files, html) => {
      // 워드·엑셀에서 복사하면 글과 함께 그 모습을 찍은 그림도 실린다. 글이 있으면 글을 붙여 넣는다.
      if (html && new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()) {
        editor.view.pasteHTML(html);
      } else {
        handlers.insert(editor, files);
      }
    },
    onDrop: (editor, files, pos) => handlers.insert(editor, files, pos),
  }),
  UploadPlaceholder,
  EmptyParagraphHint,
  BlockMove,
  SlashCommand.configure({ canInsertImage: handlers.canInsert, pickImage: handlers.pick }),
  PasteGuard.configure({
    onPasted: (editor, { remote, files, spots }) => handlers.insert(editor, files, spots, remote),
  }),
];

const EDITOR_PROPS = {
  attributes: { class: "editor-body", "aria-label": "노트 본문", spellcheck: "false" },
};

export function Editor({ content = EMPTY_DOC, onChange, onImageUpload, autofocus = "end", onEditor, onNotify }: EditorProps) {
  const uploadRef = useRef(onImageUpload);
  uploadRef.current = onImageUpload;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  // 한 번만 만드는 handlers 안에서도 지금 콜백을 부르게 ref로 읽는다. 빈 문구는 띄우지 않는다.
  const [notify] = useState(() => (message: string) => void (message && notifyRef.current?.(message)));

  const [handlers] = useState<ImageHandlers>(() => ({
    canInsert: () => !!uploadRef.current,
    pick: () => fileInputRef.current?.click(),
    insert: async (editor, all, pos, remote = 0) => {
      const batch = new ImageBatch(remote);
      const files = batch.check(all);
      const upload = uploadRef.current;
      if (!files.length || !upload) {
        // 저장 콜백이 없으면 붙여넣기·끌어 놓기로도 넣지 않는다(이미지 넣기 메뉴도 꺼져 있다).
        notify(files.length ? "이미지를 저장할 곳이 없어 넣지 않았습니다." : batch.message());
        return;
      }
      // 저장하는 동안 놓을 자리에 회색 상자를 둔다. 상자는 그동안의 편집을 따라 옮겨진다.
      // 넣은 이미지는 선택된 채로 남는다. 이어 붙여넣은 이미지가 그것을 덮어쓰지 않게 블록이 선택돼 있으면 그 뒤에 둔다.
      const { selection } = editor.state;
      const cursor = selection instanceof NodeSelection ? selection.to : selection.from;
      // 붙여넣은 HTML의 이미지는 저마다 자리가 있다. 같은 자리로 갈 파일끼리 상자 하나에 묶는다.
      const index = new Map(all.map((f, i) => [f, i]));
      const groups = new Map<number, File[]>();
      for (const f of files) {
        const spot = (Array.isArray(pos) ? pos[index.get(f)!] : pos) ?? cursor;
        const group = groups.get(spot);
        if (group) group.push(f);
        else groups.set(spot, [f]);
      }
      const placed = [...groups].map(([spot, group]) => ({ group, id: addUploadPlaceholder(editor.view, spot, group) }));
      // 한 장이 실패해도 저장된 것은 넣는다(넣지 않으면 저장된 파일만 남는다).
      const results = await Promise.allSettled(files.map(async (f) => upload(f)));
      if (editor.isDestroyed) return;

      const names = new Map<File, string>();
      results.forEach((r, i) => (r.status === "fulfilled" ? names.set(files[i], r.value) : batch.fail(files[i], r.reason)));
      batch.inserted = names.size;
      // 상자를 걷는다. 자리가 지워졌으면 지금 커서 자리에 넣는다.
      const spots = placed.map(({ group, id }) => ({ at: removeUploadPlaceholder(editor.view, id), group }));
      const now = editor.state.selection.from;
      const inserts = spots
        .map(({ at, group }) => ({
          at: Math.min(at ?? now, editor.state.doc.content.size),
          nodes: group.flatMap((f) => (names.has(f) ? [{ type: "image", attrs: { src: names.get(f) } }] : [])),
        }))
        .filter((x) => x.nodes.length)
        // 앞 자리부터 넣어 선택이 마지막(맨 뒤) 이미지에 남게 한다. 같은 자리면 붙여넣은 순서대로 이어진다.
        .sort((a, b) => a.at - b.at);
      if (inserts.length) {
        // 여러 장도 실행 취소 한 번에 되돌린다. 앞에 넣은 것만큼 뒤 자리를 옮긴다(같은 자리면 앞에 넣은 것 뒤로).
        const chain = editor.chain().focus();
        for (const { at, nodes } of inserts)
          chain.command(({ tr, commands }) => commands.insertContentAt(tr.mapping.map(at), nodes));
        chain.run();
      }
      notify(batch.message());
    },
  }));
  const [extensions] = useState(() => createExtensions(handlers));

  const editor = useEditor({
    extensions,
    content,
    autofocus,
    editorProps: EDITOR_PROPS,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
  });
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    onEditorRef.current?.(editor, true);
    return () => onEditorRef.current?.(editor, false);
  }, [editor]);
  const link = useLinkMenu(editor, notify);

  return (
    <div className="editor">
      <Toolbar editor={editor} canInsertImage={!!onImageUpload} onPickImage={handlers.pick} />
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // 같은 파일을 다시 고를 수 있게 비운다.
          if (files.length) handlers.insert(editor, files);
        }}
      />
      <div
        className="editor-content"
        ref={wrapRef}
        onContextMenu={link.onContextMenu}
        onClickCapture={link.onClickCapture}
        onAuxClick={link.onAuxClick}
        onMouseOver={link.onMouseOver}
      >
        <BlockHandle editor={editor} wrapRef={wrapRef} />
        <EditorContent editor={editor} />
        <TableTools editor={editor} wrapRef={wrapRef} />
      </div>
      {link.menu}
    </div>
  );
}

function Toolbar({
  editor,
  canInsertImage,
  onPickImage,
}: {
  editor: TiptapEditor;
  canInsertImage: boolean;
  onPickImage: () => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive("paragraph"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      code: e.isActive("codeBlock"),
      codeLanguage: (e.getAttributes("codeBlock").language as string | null) ?? "",
      inTable: e.isActive("table"),
      // 정렬을 줄 수 있는 블록(문단·제목)일 때만 지금 정렬을 돌려준다. 값이 없으면 왼쪽.
      align: ["paragraph", "heading"].includes(e.state.selection.$from.parent.type.name)
        ? ((e.state.selection.$from.parent.attrs.textAlign as string | null) ?? "left")
        : null,
      canUndo: undoDepth(e.state) > 0,
      canRedo: redoDepth(e.state) > 0,
    }),
  });
  const run = () => editor.chain().focus();

  // 버튼은 눌러도 사라지지 않고 비활성화만 되므로 포커스가 길을 잃지 않는다.
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="블록 서식">
      <div className="editor-toolbar-group">
        <ToolButton label="실행 취소" keys="Control+Z" disabled={!s.canUndo} onClick={() => run().undo().run()} />
        <ToolButton label="다시 실행" keys="Control+Y" disabled={!s.canRedo} onClick={() => run().redo().run()} />
      </div>
      <div className="editor-toolbar-group">
        <ToolButton label="본문" pressed={s.paragraph} onClick={() => run().setParagraph().run()} />
        <ToolButton label="제목 1" hint="#" pressed={s.h1} onClick={() => run().toggleHeading({ level: 1 }).run()} />
        <ToolButton label="제목 2" hint="##" pressed={s.h2} onClick={() => run().toggleHeading({ level: 2 }).run()} />
        <ToolButton label="제목 3" hint="###" pressed={s.h3} onClick={() => run().toggleHeading({ level: 3 }).run()} />
        <ToolButton label="글머리 목록" hint="-" pressed={s.bullet} onClick={() => run().toggleBulletList().run()} />
        <ToolButton label="번호 목록" hint="1." pressed={s.ordered} onClick={() => run().toggleOrderedList().run()} />
        <ToolButton label="체크리스트" hint="[]" pressed={s.task} onClick={() => run().toggleTaskList().run()} />
        <ToolButton label="코드 블록" hint="```" pressed={s.code} onClick={() => run().toggleCodeBlock().run()} />
        <select
          className="editor-select"
          aria-label="코드 언어"
          disabled={!s.code}
          value={s.codeLanguage}
          onChange={(e) => editor.commands.updateAttributes("codeBlock", { language: e.target.value || null })}
        >
          <option value="">언어 없음</option>
          {/* ```js처럼 별칭으로 만든 블록도 지금 값이 보이게 한다. */}
          {s.codeLanguage && !CODE_LANGUAGES.some((l) => l.value === s.codeLanguage) && (
            <option value={s.codeLanguage}>{s.codeLanguage}</option>
          )}
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="editor-toolbar-group">
        {ALIGNMENTS.map(({ value, label, icon, keys }) => (
          <ToolButton
            key={value}
            label={label}
            icon={icon}
            keys={keys}
            pressed={s.align === value}
            disabled={s.align === null}
            onClick={() => run().setTextAlign(value).run()}
          />
        ))}
      </div>
      <div className="editor-toolbar-group">
        {/* 행·열 수정 도구는 커서가 표 안에 있을 때 표 아래에 뜬다(TableTools). */}
        <ToolButton
          label="표 넣기"
          disabled={s.inTable}
          onClick={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <ToolButton label="이미지 넣기" disabled={!canInsertImage} onClick={onPickImage} />
      </div>
    </div>
  );
}

const ALIGNMENTS: { value: string; label: string; icon: IconName; keys: string }[] = [
  { value: "left", label: "왼쪽 정렬", icon: "alignLeft", keys: "Control+Shift+L" },
  { value: "center", label: "가운데 정렬", icon: "alignCenter", keys: "Control+Shift+E" },
  { value: "right", label: "오른쪽 정렬", icon: "alignRight", keys: "Control+Shift+R" },
  { value: "justify", label: "양쪽 정렬", icon: "alignJustify", keys: "Control+Shift+J" },
];

type ToolButtonProps = {
  label: string;
  /** 있으면 글자 대신 아이콘을 보이고, label은 이름(aria-label)으로 쓴다. */
  icon?: IconName;
  /** 단축키(aria-keyshortcuts 형식) */
  keys?: string;
  /** 마크다운 단축 입력 안내 */
  hint?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

function ToolButton({ label, icon, keys, hint, pressed, disabled, onClick }: ToolButtonProps) {
  const tip = keys ? keys.replace(/Control/g, "Ctrl") : hint ? `입력: ${hint}` : undefined;
  return (
    <button
      type="button"
      className="editor-button"
      aria-label={icon ? label : undefined}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      title={tip ? `${label} (${tip})` : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} /> : label}
    </button>
  );
}
