// AI 패널이 편집기에 하는 일(선택 읽기·본문 평문·바꾸기·삽입)을 한곳에 모은다.
// 앱 셸은 열린 페이지의 TipTap 편집기로 createEditorTarget(editor)를 만들어 AiPanel의 target으로 넘긴다.
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { textToParagraphs } from "./aiLogic";

/** 요청할 때 잡은 선택 범위와 그 글. */
export type Snapshot = { from: number; to: number; text: string };

/** 요청 때 범위를 지켜본다. 그 범위의 글이 바뀌거나 지워지면 stale이 된다(D-28). */
export type Watch = {
  stale(): boolean;
  /** 범위를 결과로 바꾼다(실행 취소 한 번). stale이면 false. */
  replace(text: string): boolean;
  /** 범위의 마지막 블록 바로 아래에 넣는다. 범위가 사라졌으면 커서 자리에 넣는다. */
  insertBelow(text: string): void;
  dispose(): void;
};

export type AiTarget = {
  /** 빈 선택이면 null. */
  selection(): Snapshot | null;
  /** 저장 전 편집까지 포함한 본문 평문(계약-AI 4절 "보낼 때 시점"). */
  docText(): string;
  /** 선택·본문이 바뀌면 부른다. 해제 함수를 돌려준다. */
  subscribe(fn: () => void): () => void;
  watch(snap: Snapshot, onStale: () => void): Watch;
  /** 커서(선택의 끝) 자리에 넣는다. 선택한 글은 지우지 않는다. */
  insertAtCursor(text: string): void;
};

const BLOCK_SEP = "\n";

/** 한 줄이면 글자로(문단을 쪼개지 않게), 여러 줄이면 문단들로. */
function content(text: string) {
  const paras = textToParagraphs(text);
  if (paras.length === 1) return paras[0].content;
  return paras;
}

export function createEditorTarget(editor: Editor): AiTarget {
  const insertAt = (pos: number, text: string) => {
    const c = content(text);
    if (!c.length || editor.isDestroyed) return;
    editor.chain().focus().insertContentAt(Math.min(pos, editor.state.doc.content.size), c).run();
  };

  return {
    selection() {
      const { from, to, empty } = editor.state.selection;
      if (empty) return null;
      const text = editor.state.doc.textBetween(from, to, BLOCK_SEP);
      return text.trim() ? { from, to, text } : null;
    },
    docText: () => editor.getText(),
    subscribe(fn) {
      editor.on("selectionUpdate", fn);
      editor.on("update", fn);
      return () => {
        editor.off("selectionUpdate", fn);
        editor.off("update", fn);
      };
    },
    watch(snap, onStale) {
      let { from, to } = snap;
      let stale = false;
      const mark = () => {
        if (stale) return;
        stale = true;
        stop();
        onStale();
      };
      const onTr = ({ transaction: tr }: { transaction: Transaction }) => {
        if (!tr.docChanged) return;
        const a = tr.mapping.mapResult(from, 1);
        const b = tr.mapping.mapResult(to, -1);
        from = a.pos;
        to = b.pos;
        if (a.deleted || b.deleted || to <= from || tr.doc.textBetween(from, to, BLOCK_SEP) !== snap.text) mark();
      };
      const stop = () => {
        editor.off("transaction", onTr);
        editor.off("destroy", mark);
      };
      editor.on("transaction", onTr);
      // 다른 페이지로 가면 편집기가 없어진다.
      editor.on("destroy", mark);
      return {
        stale: () => stale,
        replace(text) {
          const c = content(text);
          if (stale || editor.isDestroyed || !c.length) return false;
          stop(); // 바꾸면서 생기는 변경으로 stale이 되지 않게
          stale = true; // 한 번 바꾼 범위는 다시 바꾸지 않는다
          const ok = editor.chain().focus().insertContentAt({ from, to }, c).run();
          if (!ok) onStale(); // 이제 지켜보지 않으니 패널도 바꾸기를 끈다
          return ok;
        },
        insertBelow(text) {
          if (editor.isDestroyed) return;
          if (stale) {
            insertAt(editor.state.selection.to, text);
            return;
          }
          const $end = editor.state.doc.resolve(to);
          // 맨 위 블록(문단·목록·표 등)의 뒤. 문서 바로 아래 글자 자리는 없다.
          const pos = $end.depth >= 1 ? $end.after(1) : to;
          const paras = textToParagraphs(text);
          if (!paras.length) return;
          editor.chain().focus().insertContentAt(pos, paras).run();
        },
        dispose: stop,
      };
    },
    insertAtCursor: (text) => insertAt(editor.state.selection.to, text),
  };
}
