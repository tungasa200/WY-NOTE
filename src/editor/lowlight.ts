import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

// 언어 정의를 번들에 넣어 오프라인에서 강조한다(NF-06). 필요한 언어만 등록해 번들을 줄인다.
// 등록과 언어 선택 목록을 이 표 하나에서 만든다.
const LANGUAGES = [
  { value: "javascript", label: "JavaScript", grammar: javascript },
  { value: "typescript", label: "TypeScript", grammar: typescript },
  { value: "python", label: "Python", grammar: python },
  { value: "rust", label: "Rust", grammar: rust },
  { value: "json", label: "JSON", grammar: json },
  { value: "bash", label: "Bash", grammar: bash },
  { value: "sql", label: "SQL", grammar: sql },
  { value: "xml", label: "HTML/XML", grammar: xml },
  { value: "css", label: "CSS", grammar: css },
  { value: "markdown", label: "Markdown", grammar: markdown },
];

export const lowlight = createLowlight(Object.fromEntries(LANGUAGES.map((l) => [l.value, l.grammar])));

export const CODE_LANGUAGES = LANGUAGES.map(({ value, label }) => ({ value, label }));
