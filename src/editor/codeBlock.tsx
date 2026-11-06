import { useEffect, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import CodeBlockLowlight, { type CodeBlockLowlightOptions } from "@tiptap/extension-code-block-lowlight";
import { Icon } from "./icons";

type Options = CodeBlockLowlightOptions & {
  /** 알림 문구(S-13). 복사 실패만 알린다. */
  onNotify: (message: string) => void;
};

const COPIED_MS = 1500;

/** 코드 블록 + 왼쪽 위 복사 버튼(P6-4, S-06). 버튼은 문서 밖(노드 뷰)이라 JSON·내보내기에 들어가지 않는다. */
function CodeBlockView({ node, extension }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      // 언어 이름은 빼고 코드 글만, 탭은 탭 그대로.
      await navigator.clipboard.writeText(node.textContent);
    } catch {
      // 앞선 성공의 체크·문구가 실패 알림과 함께 남지 않게 지운다.
      window.clearTimeout(timer.current);
      setCopied(false);
      setStatus("");
      (extension.options as Options).onNotify("코드를 복사하지 못했습니다.");
      return;
    }
    setCopied(true);
    // 같은 문구를 다시 넣으면 낭독기가 읽지 않으므로 비웠다가 넣는다.
    setStatus("");
    requestAnimationFrame(() => setStatus("코드를 복사했습니다"));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setStatus("");
    }, COPIED_MS);
  };

  const language = node.attrs.language as string | null;
  const { languageClassPrefix } = extension.options as Options;
  return (
    <NodeViewWrapper className="editor-code">
      <button
        type="button"
        className="editor-code-copy"
        contentEditable={false}
        aria-label="코드 복사"
        title="코드 복사"
        data-copied={copied || undefined}
        // 마우스로 눌러도 편집기의 커서·선택을 옮기지 않는다. 코드 안 Tab은 들여쓰기라 버튼은 마우스 보조다(키보드는 선택 후 Ctrl+C).
        onMouseDown={(e) => e.preventDefault()}
        onClick={copy}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <span className="editor-code-status" contentEditable={false} aria-live="polite">
        {status}
      </span>
      <pre>
        {/* NodeViewContent는 기본으로 pre-wrap을 인라인으로 단다. 긴 줄은 접지 않고 가로로 스크롤한다(S-06). */}
        <NodeViewContent<"code"> as="code" className={language ? `${languageClassPrefix}${language}` : undefined} style={{ whiteSpace: "pre" }} />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend<Options>({
  addOptions() {
    return { ...this.parent!(), onNotify: () => {} };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
