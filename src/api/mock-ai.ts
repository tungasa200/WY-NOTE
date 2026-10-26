// 브라우저 개발용 가짜 AI 백엔드. 실제 API를 부르지 않는다. Rust의 검사 순서(계약-AI 3절)와 Channel 조각 전달을 흉내 낸다.
// 상태(키 끝 4자리·상한·사용 기록·전송 제외)는 localStorage에 둔다. 페이지 부모 관계는 mock.ts의 DB를 읽기만 한다.
// 시험용 표시: 입력에 "#잘림"이 있으면 truncated, "#거부"·"#문맥"이면 stopReason refusal·model_context_window_exceeded, "#실패"면 AiApi, "#크레딧"이면 AiCredit, "#느림"이면 조각을 천천히 보낸다.
// 키는 "sk-ant-"로 시작하고 20자 이상이면 통과한다. "sk-ant-bad"로 시작하면 AiAuth.
import type { PageId } from "../lib/db-types";
import { AI_INPUT_LIMIT, type AiExcludeMode, type AiResult, type AiStatus, type AiUsageDay } from "../lib/ai-types";
import type { AiBackend, OnDelta } from "./ai";

type State = {
  last4: string | null;
  dailyLimit: number;
  usage: AiUsageDay[];
  exclude: Record<string, AiExcludeMode>;
};

const KEY = "wy-note-mock-ai";
const PAGES_KEY = "wy-note-mock-db"; // mock.ts와 같은 키

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // 저장소를 못 쓰면 메모리로만 돈다.
  }
  return { last4: null, dailyLimit: 50, usage: [], exclude: {} };
}

function parentOf(id: PageId): PageId | null {
  try {
    const db = JSON.parse(localStorage.getItem(PAGES_KEY) ?? "null") as { rows: { id: PageId; parentId: PageId | null }[] } | null;
    return db?.rows.find((r) => r.id === id)?.parentId ?? null;
  } catch {
    return null;
  }
}

function fail(kind: string, message: string): never {
  throw { kind, message };
}

const chars = (s: string) => [...s].length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function createMockAi(): AiBackend {
  const st = load();
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {
      // 위와 같다.
    }
  };
  const running = new Map<string, { cancelled: boolean }>();

  const excluded = (pageId: PageId): AiStatus["excluded"] => {
    const own = st.exclude[pageId] ?? "none";
    if (own !== "none") return "self";
    for (let p = parentOf(pageId), guard = 0; p !== null && guard < 1000; p = parentOf(p), guard++) {
      if (st.exclude[p] === "subtree") return "ancestor";
    }
    return "none";
  };
  const callsOn = (day: string) => st.usage.find((u) => u.day === day)?.calls ?? 0;
  const record = (day: string, n: number) => {
    const u = st.usage.find((x) => x.day === day);
    if (u) {
      u.calls += 1;
      u.inputChars += n;
    } else st.usage.push({ day, calls: 1, inputChars: n });
    persist();
  };

  async function run(
    req: { requestId: string; pageId: PageId; today: string },
    input: string,
    inputChars: number,
    reply: string,
    onDelta: OnDelta,
  ): Promise<AiResult> {
    if (!req.requestId) fail("InvalidInput", "requestId가 비었습니다");
    if (!validDay(req.today)) fail("InvalidInput", "today는 YYYY-MM-DD여야 합니다");
    if (excluded(req.pageId) !== "none") fail("AiExcluded", "AI 전송 제외 페이지입니다");
    if (inputChars > AI_INPUT_LIMIT) fail("InputTooLong", `입력이 ${AI_INPUT_LIMIT}자를 넘습니다(${inputChars}자)`);
    if (callsOn(req.today) >= st.dailyLimit) fail("AiDailyLimit", "오늘 상한");
    if (running.size > 0) fail("AiBusy", "진행 중인 요청이 있습니다");
    const job = { cancelled: false };
    running.set(req.requestId, job);
    try {
      if (!st.last4) fail("NoApiKey", "API 키가 없습니다");
      await sleep(400);
      if (!navigator.onLine) fail("Offline", "연결 실패");
      if (input.includes("#크레딧")) fail("AiCredit", "billing_error");
      // 여기서부터는 API가 응답을 시작한 것으로 보고 센다.
      record(req.today, inputChars);
      const pieces = reply.match(/.{1,6}/gsu) ?? [];
      const gap = input.includes("#느림") ? 300 : 40;
      let text = "";
      for (const [i, piece] of pieces.entries()) {
        if (job.cancelled) fail("Cancelled", "중지했습니다");
        if (input.includes("#실패") && i === Math.floor(pieces.length / 2)) fail("AiApi", "api_error (mock)");
        text += piece;
        onDelta(piece);
        await sleep(gap);
      }
      if (job.cancelled) fail("Cancelled", "중지했습니다");
      const stopReason = input.includes("#잘림")
        ? "max_tokens"
        : input.includes("#거부")
          ? "refusal"
          : input.includes("#문맥")
            ? "model_context_window_exceeded"
            : "end_turn";
      return { text, truncated: stopReason === "max_tokens", inputChars, stopReason };
    } finally {
      running.delete(req.requestId);
    }
  }

  return {
    summarize: (req, onDelta) => {
      if (!req.text.trim()) fail("InvalidInput", "요약할 텍스트가 비었습니다");
      const head = [...req.text.replace(/\s+/g, " ").trim()].slice(0, 40).join("");
      return run(req, req.text, chars(req.text), `(가짜 요약) 선택한 ${chars(req.text)}자의 요점: "${head}…"\n- 첫째 요점\n- 둘째 요점`, onDelta);
    },
    rewrite: (req, onDelta) => {
      if (!req.text.trim()) fail("InvalidInput", "다듬을 텍스트가 비었습니다");
      return run(req, req.text, chars(req.text), req.text.replace(/\s+$/u, "") + " (가짜로 다듬음)", onDelta);
    },
    ask: (req, onDelta) => {
      if (!req.question.trim()) fail("InvalidInput", "질문이 비었습니다");
      if (req.history.length % 2 !== 0) fail("InvalidInput", "이전 대화는 질문·답 쌍이어야 합니다");
      req.history.forEach((t, i) => {
        if (t.role !== (i % 2 === 0 ? "user" : "assistant")) fail("InvalidInput", "이전 대화의 순서가 잘못되었습니다");
        if (!t.text.trim()) fail("InvalidInput", "이전 대화에 빈 항목이 있습니다");
      });
      const n = chars(req.context) + req.history.reduce((s, t) => s + chars(t.text), 0) + chars(req.question);
      const reply = `(가짜 답) 본문 ${chars(req.context)}자와 앞 대화 ${req.history.length / 2}개를 보고 답합니다: "${req.question.trim()}"에 대한 답입니다.`;
      return run(req, req.question + req.context, n, reply, onDelta);
    },
    cancel: async (requestId) => {
      const job = running.get(requestId);
      if (job) job.cancelled = true;
    },
    getStatus: async (pageId, today) => {
      if (!validDay(today)) fail("InvalidInput", "today는 YYYY-MM-DD여야 합니다");
      return {
        hasKey: st.last4 !== null,
        excluded: pageId === null ? "none" : excluded(pageId),
        excludeMode: pageId === null ? "none" : (st.exclude[pageId] ?? "none"),
        todayCalls: callsOn(today),
        dailyLimit: st.dailyLimit,
      };
    },
    setExclude: async (pageId, mode) => {
      if (!["none", "self", "subtree"].includes(mode)) fail("InvalidInput", "mode");
      st.exclude[pageId] = mode;
      persist();
    },
    setDailyLimit: async (limit) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("InvalidInput", "하루 상한은 1~1000이어야 합니다");
      st.dailyLimit = limit;
      persist();
    },
    listUsage: async (days = 30) => [...st.usage].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days),
    setApiKey: async (raw) => {
      const key = raw.trim();
      if (!key || /\s/.test(key)) fail("InvalidInput", "API 키가 비었거나 공백이 섞여 있습니다");
      await sleep(500);
      if (!navigator.onLine) fail("Offline", "연결 실패");
      if (!key.startsWith("sk-ant-") || key.length < 20 || key.startsWith("sk-ant-bad")) fail("AiAuth", "401");
      st.last4 = key.slice(-4);
      persist();
      return { last4: st.last4 };
    },
    hasApiKey: async () => ({ present: st.last4 !== null, last4: st.last4 }),
    deleteApiKey: async () => {
      st.last4 = null;
      persist();
    },
  };
}
