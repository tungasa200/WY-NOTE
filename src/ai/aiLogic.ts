// AI 패널의 순수 계산(DOM·React 없음). scripts/check-ai.ts가 확인한다.
import { AI_INPUT_LIMIT, type AiTurn } from "../lib/ai-types.ts";

/** 유니코드 문자 수(Rust chars().count()와 같다). */
export const charCount = (s: string) => [...s].length;

const pad = (n: number) => String(n).padStart(2, "0");

/** PC 지역 날짜 'YYYY-MM-DD'(계약-AI 3절 today). */
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 지역 자정까지 남은 시간 문구. 예) "3시간 12분", "40분", "1분 미만". */
export function untilMidnight(now = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const min = Math.floor((midnight.getTime() - now.getTime()) / 60_000);
  if (min < 1) return "1분 미만";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

/** 지역 자정까지 남은 밀리초(날짜가 바뀌면 상태를 다시 읽는다). */
export function msUntilMidnight(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

/**
 * 정상 완료가 아닌 끝남의 안내 문구. 정상(end_turn·stop_sequence)과 잘림(max_tokens, truncated로 따로 표시)은 null.
 * 거부·문맥 초과·모르는 값은 정상 완료로 보지 않는다(사용자 결정 2026-10-26): 노트에 넣지 않고 복사만 둔다.
 */
export function incompleteReason(stopReason: string): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "max_tokens":
      return null;
    case "refusal":
      return "AI가 이 요청에 답하지 않았습니다";
    case "model_context_window_exceeded":
      return "문맥 한도를 넘어 결과가 끝까지 만들어지지 않았습니다";
    default:
      return "결과가 정상으로 끝나지 않았습니다";
  }
}

export type QaPair ={ question: string; answer: string };

/**
 * 질의응답에 보낼 이전 대화를 고른다(F-08.3).
 * 답이 빈 쌍(실패·답 없이 중지)은 보낼 수 없어 빼고(Rust ai_ask 규칙), 2만 자를 넘으면 오래된 쌍부터 뺀다.
 * context + question만으로 넘으면 null(보내지 않음).
 */
export function pickHistory(
  context: string,
  question: string,
  pairs: QaPair[],
  limit = AI_INPUT_LIMIT,
): { history: AiTurn[]; dropped: number } | null {
  let used = charCount(context) + charCount(question);
  if (used > limit) return null;
  const usable = pairs.filter((p) => p.question.trim() && p.answer.trim());
  // 최근 것부터 넣을 수 있는 만큼 넣는다. 한 쌍이 안 들어가면 그보다 오래된 것도 넣지 않는다(대화 순서 유지).
  let keep = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const n = charCount(usable[i].question) + charCount(usable[i].answer);
    if (used + n > limit) break;
    used += n;
    keep++;
  }
  const kept = usable.slice(usable.length - keep);
  return {
    history: kept.flatMap((p): AiTurn[] => [
      { role: "user", text: p.question },
      { role: "assistant", text: p.answer },
    ]),
    dropped: usable.length - keep,
  };
}

/** AI 결과 글을 문단 노드로 바꾼다(줄마다 문단, 빈 줄은 건너뜀). 문자열을 HTML로 해석하지 않게 JSON 노드로 넘긴다. */
export function textToParagraphs(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
}
