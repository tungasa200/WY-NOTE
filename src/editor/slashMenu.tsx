import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { Extension, ReactRenderer, type Editor, type Range } from "@tiptap/react";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { Icon, type IconName } from "./icons";

type SlashItem = {
  title: string;
  group: "기본 블록" | "더 보기";
  /** 아이콘 이름, 또는 아이콘 자리에 쓸 글자(H1 등) */
  icon: IconName | { label: string };
  description?: string;
  /** 마크다운 단축 입력 안내 */
  hint?: string;
  /** 거르기에 쓰는 다른 이름(소문자) */
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
};

type SlashOptions = {
  /** 이미지 넣기를 할 수 있는가(저장 콜백이 있는가) */
  canInsertImage: () => boolean;
  /** 파일 선택 창을 연다 */
  pickImage: () => void;
};

const MENU_ID = "editor-slash-menu";

function buildItems({ canInsertImage, pickImage }: SlashOptions, editor: Editor): SlashItem[] {
  const block = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);
  const items: SlashItem[] = [
    { title: "문단", group: "기본 블록", icon: "text", description: "그냥 글", keywords: ["text", "paragraph", "본문"], run: (e, r) => block(e, r).setParagraph().run() },
    { title: "제목 1", group: "기본 블록", icon: { label: "H1" }, description: "큰 제목", hint: "#", keywords: ["h1", "heading"], run: (e, r) => block(e, r).setHeading({ level: 1 }).run() },
    { title: "제목 2", group: "기본 블록", icon: { label: "H2" }, description: "중간 제목", hint: "##", keywords: ["h2", "heading"], run: (e, r) => block(e, r).setHeading({ level: 2 }).run() },
    { title: "제목 3", group: "기본 블록", icon: { label: "H3" }, description: "작은 제목", hint: "###", keywords: ["h3", "heading"], run: (e, r) => block(e, r).setHeading({ level: 3 }).run() },
    { title: "글머리 목록", group: "기본 블록", icon: "list", hint: "-", keywords: ["bullet", "list", "ul"], run: (e, r) => block(e, r).toggleBulletList().run() },
    { title: "번호 목록", group: "기본 블록", icon: "olist", hint: "1.", keywords: ["number", "ordered", "list", "ol"], run: (e, r) => block(e, r).toggleOrderedList().run() },
    { title: "체크리스트", group: "기본 블록", icon: "todo", hint: "[]", keywords: ["todo", "task", "check", "할 일"], run: (e, r) => block(e, r).toggleTaskList().run() },
    { title: "코드", group: "더 보기", icon: "code", description: "고정폭, 문법 강조", hint: "```", keywords: ["code", "코드 블록"], run: (e, r) => block(e, r).setCodeBlock().run() },
  ];
  if (!editor.isActive("table")) {
    items.push({
      title: "표",
      group: "더 보기",
      icon: "table",
      description: "3 × 3으로 시작",
      keywords: ["table"],
      run: (e, r) => block(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    });
  }
  if (canInsertImage()) {
    items.push({
      title: "이미지",
      group: "더 보기",
      icon: "image",
      description: "파일 선택",
      keywords: ["image", "picture", "그림", "사진"],
      run: (e, r) => {
        block(e, r).run();
        pickImage();
      },
    });
  }
  return items;
}

function matches(item: SlashItem, query: string) {
  const q = query.trim().toLowerCase();
  return !q || item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.includes(q));
}

type SlashMenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

type SlashMenuProps = SuggestionProps<SlashItem, SlashItem> & { ref?: Ref<SlashMenuHandle> };

function SlashMenu({ items, command, editor, ref }: SlashMenuProps) {
  const [active, setActive] = useState(0);
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setActive(0);
  }

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown(event) {
        // 한글 조합 중의 Enter는 글자 확정이므로 항목을 고르지 않는다.
        // Alt+↑/↓(블록 이동) 같은 조합키는 편집기로 넘긴다.
        if (!items.length || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((a) => (a + step + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          command(items[active]);
          return true;
        }
        return false;
      },
    }),
    [items, active, command],
  );

  // 포커스는 편집 영역에 그대로 두고, 화면 낭독기에는 고른 항목을 알린다.
  useEffect(() => {
    const dom = editor.view.dom;
    dom.setAttribute("aria-controls", MENU_ID);
    dom.setAttribute("aria-expanded", "true");
    if (items.length) dom.setAttribute("aria-activedescendant", `${MENU_ID}-${active}`);
    else dom.removeAttribute("aria-activedescendant");
    document.getElementById(`${MENU_ID}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [editor, items, active]);
  useEffect(() => {
    const dom = editor.view.dom;
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor]);

  return (
    <div className="slash-menu" id={MENU_ID} role="listbox" aria-label="블록 종류">
      {items.length === 0 && (
        <div className="slash-menu-empty" role="option" aria-disabled="true" aria-selected="false">
          일치하는 블록 없음
        </div>
      )}
      {items.map((item, i) => (
        <div key={item.title} role="presentation">
          {item.group !== items[i - 1]?.group && (
            <>
              {i > 0 && <div className="slash-menu-sep" role="separator" />}
              <div className="slash-menu-label" role="presentation">
                {item.group}
              </div>
            </>
          )}
          <div
            id={`${MENU_ID}-${i}`}
            role="option"
            aria-selected={i === active}
            className="slash-menu-item"
            // 누르는 동안 편집 영역의 포커스·선택을 잃지 않게 한다.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => command(item)}
          >
            <span className="slash-menu-icon" aria-hidden="true">
              {typeof item.icon === "string" ? <Icon name={item.icon} /> : item.icon.label}
            </span>
            <span className="slash-menu-text">
              {item.title}
              {item.description && <small>{item.description}</small>}
            </span>
            {item.hint && (
              <span className="slash-menu-hint" aria-hidden="true">
                {item.hint}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const slashMenuKey = new PluginKey("slashMenu");

/** 빈 줄 맨 앞에서 `/`로 여는 블록 종류 메뉴(F-02, S-06b). */
export const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",
  addOptions() {
    return { canInsertImage: () => false, pickImage: () => {} };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        pluginKey: slashMenuKey,
        editor: this.editor,
        char: "/",
        startOfLine: true,
        // 문단에서만 연다. 코드 블록 안의 `/`는 그냥 글자다.
        allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name === "paragraph",
        items: ({ query, editor }) => buildItems(options, editor).filter((item) => matches(item, query)),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null = null;
          let unmount: (() => void) | null = null;
          let emptyQuery: string | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props) => {
              // 맞는 것이 없는 상태에서 한 글자 더 치면 메뉴를 닫는다. 친 글자는 그대로 남는다(S-06b).
              if (!props.items.length && emptyQuery !== null && props.query.length > emptyQuery.length) {
                exitSuggestion(props.editor.view, slashMenuKey);
                return;
              }
              emptyQuery = props.items.length ? null : props.query;
              renderer?.updateProps(props);
            },
            onKeyDown: ({ event }) => renderer?.ref?.onKeyDown(event) ?? false,
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              renderer = null;
              unmount = null;
              emptyQuery = null;
            },
          };
        },
      }),
    ];
  },
});
