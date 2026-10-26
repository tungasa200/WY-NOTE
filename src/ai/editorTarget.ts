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
  dispose(): void;
};

export type AiTarget = {
  /** 빈 선택이면 null. */
  selection(): Snapshot | null;
  /** 저장 전 편집까지 포함한 본문 평문(계약-AI 4절 "보낼 때 시점"). 본문이 그대로면 앞서 만든 값을 돌려준다. */
  docText(): string;
  /** 선택·본문이 바뀌면 키 한 번에 한 번 부른다(docChanged: 본문이 바뀌었나). 해제 함수를 돌려준다. */
  subscribe(fn: (docChanged: boolean) => void): () => void;
  watch(snap: Snapshot, onStale: () => void): Watch;
  /**
   * 새 문단(들)로 넣는다. 선택 끝(선택이 없으면 커서)이 든 최상위 블록 바로 아래에 넣고, 블록을 쪼개지 않는다.
   * 목록·코드 블록 안이어도 같다. 선택한 글은 지우지 않는다(F-08.1, 세 탭 공통, pm 결정).
   */
  insertBelow(text: string): void;
};

const BLOCK_SEP = "\n";

/** 한 줄이면 글자로(문단을 쪼개지 않게), 여러 줄이면 문단들로. */
function content(text: string) {
  const paras = textToParagraphs(text);
  if (paras.length === 1) return paras[0].content;
  return paras;
}

export function createEditorTarget(editor: Editor): AiTarget {
  // 문서 전체 평문은 길다(5만 자). ProseMirror 문서는 바뀌면 새 객체이므로 같은 문서면 다시 만들지 않는다.
  let cached: { doc: unknown; text: string } | null = null;
  return {
    selection() {
      const { from, to, empty } = editor.state.selection;
      if (empty) return null;
      const text = editor.state.doc.textBetween(from, to, BLOCK_SEP);
      return text.trim() ? { from, to, text } : null;
    },
    docText() {
      const doc = editor.state.doc;
      if (cached?.doc !== doc) cached = { doc, text: editor.getText() };
      return cached.text;
    },
    subscribe(fn) {
      // update와 selectionUpdate는 글자 하나에 둘 다 온다. transaction 하나로 받는다.
      // appendTransaction(붙여넣기 정리 등)이 바꾼 것도 받는다.
      const on = ({ transaction: tr, appendedTransactions: more = [] }: { transaction: Transaction; appendedTransactions?: Transaction[] }) => {
        const trs = [tr, ...more];
        const docChanged = trs.some((t) => t.docChanged);
        if (docChanged || trs.some((t) => t.selectionSet)) fn(docChanged);
      };
      editor.on("transaction", on);
      return () => {
        editor.off("transaction", on);
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
        dispose: stop,
      };
    },
    insertBelow: (text) => {
      const paras = textToParagraphs(text);
      if (!paras.length || editor.isDestroyed) return;
      const { selection, doc } = editor.state;
      // 선택이 다음 블록 맨 앞에서 끝나면(줄 끝까지 끌어 고른 경우) 그 블록은 고른 게 아니다. 한 칸 앞을 본다.
      const $to = !selection.empty && selection.$to.parentOffset === 0 ? doc.resolve(selection.to - 1) : selection.$to;
      // 깊이 0이면(최상위 블록을 통째로 고른 경우 등) 이미 블록 사이 자리다.
      const at = $to.depth === 0 ? $to.pos : $to.after(1);
      editor.chain().focus().insertContentAt(at, paras).scrollIntoView().run();
    },
  };
}
