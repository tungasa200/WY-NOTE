// 페이지 제목을 화면 문구에 넣는 헬퍼. 공백뿐인 제목도 "제목 없음"으로 본다.

export const isUntitled = (title: string) => !title.trim();

export const displayTitle = (title: string) => title.trim() || "제목 없음";

/** "제목" */
export const quote = (title: string) => `"${displayTitle(title)}"`;

/** 목적어: "제목"을 / "제목"를 */
export const quoteObject = (title: string) => quote(title) + josa(title, "을", "를");

/** 받침이 있으면 withBatchim, 없으면 without. 한글·숫자가 아닌 끝 글자는 "을(를)"처럼 둘 다 쓴다. */
export function josa(title: string, withBatchim: string, without: string): string {
  const last = displayTitle(title).slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? withBatchim : without;
  if (/[0-9]/.test(last)) return "013678".includes(last) ? withBatchim : without;
  return `${withBatchim}(${without})`;
}
