import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Ellipsis,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Plus,
  Redo2,
  SquareCheck,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
  Type,
  Underline,
  Undo2,
} from "lucide-react";

// 아이콘은 lucide-react(사용자 결정). 쓰는 것만 import해 번들에 그것만 들어간다.
const ICONS = {
  text: Type,
  list: List,
  olist: ListOrdered,
  todo: SquareCheck,
  code: Code,
  codeBlock: SquareCode,
  table: Table,
  image: Image,
  plus: Plus,
  grip: GripVertical,
  link: Link,
  alignLeft: AlignLeft,
  alignCenter: AlignCenter,
  alignRight: AlignRight,
  alignJustify: AlignJustify,
  undo: Undo2,
  redo: Redo2,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  quote: TextQuote,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strike: Strikethrough,
  rule: Minus,
  more: Ellipsis,
};

export type IconName = keyof typeof ICONS;

/** 16px, 24 격자, 선 1.6(화면설계 아이콘 규칙). 장식용이라 화면 낭독기에서는 숨긴다. */
export function Icon({ name }: { name: IconName }) {
  const Svg = ICONS[name];
  return <Svg className="ico" size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" />;
}
