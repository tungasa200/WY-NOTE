// 코드 블록 문법 강조 플러그인(P7-4, NF-04).
// @tiptap/extension-code-block-lowlight의 강조 플러그인은 코드 블록 안에서 한 글자만 쳐도 문서의 모든 코드 블록을
// 다시 강조한다(코드 블록 30개·5만 자에서 키마다 약 30ms). 여기서는 이번 거래가 건드린 범위의 블록만 다시 강조하고,
// 나머지 블록의 강조는 mapping으로 옮긴다. 결과는 문서 전체를 다시 강조한 것과 같다(scripts/check-code-highlight.ts).
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AttrStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { createLowlight } from "lowlight";

type Lowlight = ReturnType<typeof createLowlight>;
type HastNode = { type: string; value?: string; children?: HastNode[]; properties?: { className?: string[] } };
type Options = { name: string; lowlight: Lowlight; defaultLanguage: string | null | undefined };

/** 강조 결과(hast)를 글자 조각과 클래스 목록으로 펼친다. */
function flatten(nodes: HastNode[], classes: string[], out: { len: number; classes: string[] }[]) {
  for (const node of nodes) {
    const next = node.properties?.className ? [...classes, ...node.properties.className] : classes;
    if (node.children) flatten(node.children, next, out);
    else out.push({ len: node.value?.length ?? 0, classes: next });
  }
  return out;
}

/** 코드 블록 하나(pos = 블록 바로 앞 위치)의 decoration. */
function blockDecorations(node: PMNode, pos: number, { lowlight, defaultLanguage }: Options) {
  const language = (node.attrs.language as string | null) || defaultLanguage;
  const text = node.textContent;
  const tree = language && lowlight.registered(language) ? lowlight.highlight(language, text) : lowlight.highlightAuto(text);
  const decorations: Decoration[] = [];
  let from = pos + 1;
  for (const piece of flatten(tree.children as HastNode[], [], [])) {
    const to = from + piece.len;
    if (piece.classes.length) decorations.push(Decoration.inline(from, to, { class: piece.classes.join(" ") }));
    from = to;
  }
  return decorations;
}

/** 이번 거래가 바꾼 곳을 모두 덮는 범위 하나(새 문서 위치). 단계 수에 비례해서만 든다.
 *  속성만 바꾼 단계(AttrStep)는 mapping에 범위가 없어 따로 넣는다. */
function changedRange(tr: Transaction): [number, number] | null {
  let range: [number, number] | null = null;
  tr.mapping.maps.forEach((map, i) => {
    if (range) range = [map.map(range[0], -1), map.map(range[1], 1)];
    const add = (from: number, to: number) => (range = range ? [Math.min(range[0], from), Math.max(range[1], to)] : [from, to]);
    map.forEach((_oldStart, _oldEnd, from, to) => add(from, to));
    const step = tr.steps[i];
    if (step instanceof AttrStep) add(step.pos, step.pos + 1);
  });
  return range;
}

export function codeHighlightPlugin(options: Options) {
  // 원래 플러그인처럼 부를 때마다 새 키(같은 편집기에 두 번 들어가도 부딪히지 않게).
  const key = new PluginKey<DecorationSet>("codeHighlight");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, { doc }) => {
        const decorations: Decoration[] = [];
        doc.descendants((node, pos) => {
          if (node.type.name === options.name) decorations.push(...blockDecorations(node, pos, options));
          return !node.isTextblock;
        });
        return DecorationSet.create(doc, decorations);
      },
      apply: (tr, set) => {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const range = changedRange(tr);
        if (!range) return next;
        // 범위에 걸친 글 블록은 모두 강조를 지우고, 지금도 코드 블록인 것만 다시 강조한다
        // (코드 블록이 문단으로 바뀌거나 문단에 합쳐지면 옮겨진 강조가 남지 않게).
        tr.doc.nodesBetween(range[0], range[1], (node, pos) => {
          if (!node.isTextblock) return true;
          const stale = next.find(pos, pos + node.nodeSize);
          if (stale.length) next = next.remove(stale);
          if (node.type.name === options.name) next = next.add(tr.doc, blockDecorations(node, pos, options));
          return false;
        });
        return next;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}
