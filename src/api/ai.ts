// AI·API 키 명령(docs/계약-AI.md 1.4·4절)을 감싼 클라이언트. 화면은 invoke를 직접 부르지 않고 이것만 쓴다.
// 결과 조각은 Tauri Channel로 받는다(2.5). Tauri 밖(브라우저 개발)에서는 가짜 구현(mock-ai.ts)으로 바뀐다.
// 실패하면 AppError({ kind, message })로 reject한다(db-types). 종류 판정·안내 문구는 api/index.ts의 errorKind·errorReason.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { PageId } from "../lib/db-types";
import type {
  AiEvent,
  AiExcludeMode,
  AiRequestBase,
  AiResult,
  AiStatus,
  AiTurn,
  AiUsageDay,
  KeyStatus,
} from "../lib/ai-types";

export type OnDelta = (text: string) => void;

export type AiBackend = {
  summarize(req: AiRequestBase & { text: string }, onDelta: OnDelta): Promise<AiResult>;
  rewrite(req: AiRequestBase & { text: string }, onDelta: OnDelta): Promise<AiResult>;
  /** history는 user·assistant가 번갈아 오는 쌍이고 text가 비면 안 된다(Rust ai_ask 규칙). */
  ask(req: AiRequestBase & { context: string; history: AiTurn[]; question: string }, onDelta: OnDelta): Promise<AiResult>;
  cancel(requestId: string): Promise<void>;
  getStatus(pageId: PageId | null, today: string): Promise<AiStatus>;
  setExclude(pageId: PageId, mode: AiExcludeMode): Promise<void>;
  setDailyLimit(limit: number): Promise<void>;
  listUsage(days?: number): Promise<AiUsageDay[]>;
  /** 시험 호출을 통과해야만 저장한다(D-21). */
  setApiKey(key: string): Promise<{ last4: string }>;
  hasApiKey(): Promise<KeyStatus>;
  deleteApiKey(): Promise<void>;
};

function channel(onDelta: OnDelta): Channel<AiEvent> {
  const ch = new Channel<AiEvent>();
  ch.onmessage = (e) => {
    if (e.type === "delta") onDelta(e.text);
  };
  return ch;
}

const tauriAi: AiBackend = {
  summarize: (req, onDelta) => invoke("ai_summarize", { ...req, onEvent: channel(onDelta) }),
  rewrite: (req, onDelta) => invoke("ai_rewrite", { ...req, onEvent: channel(onDelta) }),
  ask: (req, onDelta) => invoke("ai_ask", { ...req, onEvent: channel(onDelta) }),
  cancel: (requestId) => invoke("ai_cancel", { requestId }),
  getStatus: (pageId, today) => invoke("get_ai_status", { pageId, today }),
  setExclude: (pageId, mode) => invoke("set_ai_exclude", { pageId, mode }),
  setDailyLimit: (limit) => invoke("set_ai_daily_limit", { limit }),
  listUsage: (days) => invoke("list_ai_usage", days === undefined ? {} : { days }),
  setApiKey: (key) => invoke("set_api_key", { key }),
  hasApiKey: () => invoke("has_api_key"),
  deleteApiKey: () => invoke("delete_api_key"),
};

let backend: Promise<AiBackend> | null = null;

/** 처음 부를 때 백엔드를 고른다. mock은 Tauri 빌드에서 별도 조각으로만 남는다. */
function current(): Promise<AiBackend> {
  backend ??= isTauri() ? Promise.resolve(tauriAi) : import("./mock-ai").then((m) => m.createMockAi());
  return backend;
}

export const aiApi: AiBackend = new Proxy({} as AiBackend, {
  // then·심볼에는 함수를 주지 않는다(주면 aiApi가 Promise처럼 보여 await가 멈춘다).
  get: (_t, name) =>
    typeof name !== "string" || name === "then"
      ? undefined
      : (...args: unknown[]) => current().then((b) => (b[name as keyof AiBackend] as (...a: unknown[]) => Promise<unknown>)(...args)),
});
