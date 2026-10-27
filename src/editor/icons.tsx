import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Code, GripVertical, Image, Link, List, ListOrdered, Plus, SquareCheck, Table, Type } from "lucide-react";

// 아이콘은 lucide-react(사용자 결정). 쓰는 것만 import해 번들에 그것만 들어간다.
const ICONS = {
  text: Type,
  list: List,
  olist: ListOrdered,
  todo: SquareCheck,
  code: Code,
  table: Table,
  image: Image,
  plus: Plus,
  grip: GripVertical,
  link: Link,
  alignLeft: AlignLeft,
  alignCenter: AlignCenter,
  alignRight: AlignRight,
  alignJustify: AlignJustify,
};

export type IconName = keyof typeof ICONS;

/** 16px, 24 격자, 선 1.6(화면설계 아이콘 규칙). 장식용이라 화면 낭독기에서는 숨긴다. */
export function Icon({ name }: { name: IconName }) {
  const Svg = ICONS[name];
  return <Svg className="ico" size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" />;
}
