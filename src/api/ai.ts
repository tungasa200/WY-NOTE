// AI·API 키 명령(docs/계약-AI.md 1.4·4절)을 감싼 클라이언트. 화면은 invoke를 직접 부르지 않고 이것만 쓴다.
// 결과 조각은 Tauri Channel로 받는다(2.5). Tauri 밖(브라우저 개발)에서는 가짜 구현(mock-ai.ts)으로 바뀐다.
// 실패하면 AppError({ kind, message })로 reject한다. kind는 db-types의 것 + ai-types의 AiErrorKind.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { PageId } from "../lib/db-types";
import type {
  AiErrorKind,
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

export function aiErrorKind(e: unknown): AiErrorKind | string | null {
  return typeof e === "object" && e !== null && "kind" in e ? String((e as { kind: unknown }).kind) : null;
}

/** 패널·설정에 띄울 짧은 이유(계약-AI 4.1 "화면 안내"). 개발자용 message는 보이지 않는다. */
export function aiErrorReason(e: unknown): string {
  switch (aiErrorKind(e)) {
    case "NoApiKey":
      return "API 키가 없습니다";
    case "Keyring":
      return "자격 증명 관리자에 접근하지 못했습니다";
    case "Offline":
      return "인터넷에 연결할 수 없습니다";
    case "AiTimeout":
      return "응답 시간이 초과되었습니다";
    case "AiAuth":
      return "잘못된 키이거나 권한이 없는 키입니다";
    case "AiCredit":
      return "이번 달 크레딧 소진";
    case "AiRateLimit":
      return "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요";
    case "AiOverloaded":
      return "AI 서버가 바쁩니다. 잠시 뒤 다시 시도하세요";
    case "AiExcluded":
      return "AI 전송 제외 페이지입니다";
    case "AiDailyLimit":
      return "오늘 호출 상한에 도달했습니다";
    case "InputTooLong":
      return "보낼 글이 20,000자를 넘습니다. 범위를 줄이세요";
    case "AiBusy":
      return "다른 AI 작업이 진행 중입니다";
    case "InvalidInput":
      return "잘못된 입력입니다";
    case "Db":
      return "데이터베이스에 쓰지 못했습니다";
    default:
      return "AI 요청이 실패했습니다";
  }
}
