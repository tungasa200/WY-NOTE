// AI 패널 순수 계산(F-08.3·F-08.7) 확인 스크립트. 테스트 프레임워크 없이 Node 타입 제거 실행으로 돈다.
// 실행: node scripts/check-ai.ts  (시간대도 바꿔 본다: TZ=UTC node scripts/check-ai.ts)
import assert from "node:assert/strict";
import { charCount, incompleteReason, localDay, msUntilMidnight, pickHistory, textToParagraphs, untilMidnight } from "../src/ai/aiLogic.ts";

let n = 0;
const check = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("ok", name);
};

check("charCount는 유니코드 문자 수(이모지 1자)", () => {
  assert.equal(charCount("가나다"), 3);
  assert.equal(charCount("a😀b"), 3);
});

check("localDay는 지역 날짜", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

check("untilMidnight 문구", () => {
  assert.equal(untilMidnight(new Date(2026, 3, 1, 20, 48)), "3시간 12분");
  assert.equal(untilMidnight(new Date(2026, 3, 1, 23, 20)), "40분");
  assert.equal(untilMidnight(new Date(2026, 3, 1, 23, 59, 30)), "1분 미만");
  assert.equal(msUntilMidnight(new Date(2026, 3, 1, 23, 0)), 3_600_000);
});

const pair = (q: string, a: string) => ({ question: q, answer: a });

check("pickHistory: 다 들어가면 순서대로 쌍을 보낸다", () => {
  const r = pickHistory("본문", "질문", [pair("q1", "a1"), pair("q2", "a2")]);
  assert.deepEqual(r, {
    history: [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ],
    dropped: 0,
  });
});

check("pickHistory: 답이 빈 쌍(실패·중지)은 빼고 dropped에 넣지 않는다", () => {
  const r = pickHistory("본문", "질문", [pair("q1", ""), pair("q2", "  "), pair("q3", "a3")]);
  assert.equal(r?.history.length, 2);
  assert.equal(r?.dropped, 0);
});

check("pickHistory: 넘치면 오래된 쌍부터 뺀다", () => {
  // 상한 20: 본문 4 + 질문 2 = 6, 남은 14. 최근 쌍 6자, 그다음 6자, 가장 오래된 6자는 못 넣는다.
  const r = pickHistory("abcd", "qq", [pair("aaa", "aaa"), pair("bbb", "bbb"), pair("ccc", "ccc")], 20);
  assert.deepEqual(r?.history.map((t) => t.text), ["bbb", "bbb", "ccc", "ccc"]);
  assert.equal(r?.dropped, 1);
});

check("pickHistory: 안 들어가는 쌍보다 오래된 쌍은 작아도 넣지 않는다", () => {
  const r = pickHistory("abcd", "qq", [pair("a", "a"), pair("b".repeat(10), "b".repeat(10)), pair("c", "c")], 20);
  assert.deepEqual(r?.history.map((t) => t.text), ["c", "c"]);
  assert.equal(r?.dropped, 2);
});

check("pickHistory: 본문+질문만으로 상한을 넘으면 null, 딱 맞으면 보낸다", () => {
  assert.equal(pickHistory("a".repeat(19), "qq", [], 20), null);
  assert.deepEqual(pickHistory("a".repeat(18), "qq", [pair("x", "y")], 20), { history: [], dropped: 1 });
});

check("textToParagraphs: 줄마다 문단, 빈 줄 건너뜀, CRLF 처리, HTML은 글자 그대로", () => {
  assert.deepEqual(textToParagraphs("가\r\n\r\n<b>나</b>\n"), [
    { type: "paragraph", content: [{ type: "text", text: "가" }] },
    { type: "paragraph", content: [{ type: "text", text: "<b>나</b>" }] },
  ]);
  assert.deepEqual(textToParagraphs(" \n"), []);
});

check("incompleteReason: 정상·잘림은 null, 거부·문맥 초과·모르는 값은 정상 완료가 아님", () => {
  assert.equal(incompleteReason("end_turn"), null);
  assert.equal(incompleteReason("stop_sequence"), null);
  assert.equal(incompleteReason("max_tokens"), null);
  assert.match(incompleteReason("refusal") ?? "", /답하지 않았습니다/);
  assert.match(incompleteReason("model_context_window_exceeded") ?? "", /문맥 한도/);
  assert.notEqual(incompleteReason("unknown"), null);
  assert.notEqual(incompleteReason(""), null);
});

console.log(`${n}개 통과 (TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone})`);
