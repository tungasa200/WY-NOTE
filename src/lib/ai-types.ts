// AI 계약(docs/계약-AI.md 4절)의 TS 타입. Rust 쪽 serde 형식과 같게 유지한다.
import type { PageId } from "./db-types";

export type AiEvent = { type: "delta"; text: string };

export type AiResult = {
  text: string; // 받은 전체 텍스트(조각을 이어 붙인 것과 같음)
  truncated: boolean; // stop_reason == "max_tokens"
  inputChars: number; // 이번 요청에서 센 입력 글자 수
  /** API stop_reason 원문(end_turn·max_tokens·refusal·model_context_window_exceeded 등), 없으면 "unknown"(D-31). 정상 완료는 end_turn·stop_sequence뿐. */
  stopReason: string;
};

export type AiStatus = {
  hasKey: boolean;
  excluded: "none" | "self" | "ancestor"; // ancestor = 상위 페이지가 '하위 포함'으로 제외
  /** 이 페이지 자신의 설정(ai_exclude 0/1/2, 계약-AI 4절). 조상에서 물려받은 제외는 excluded로 본다. */
  excludeMode: AiExcludeMode;
  todayCalls: number;
  dailyLimit: number;
};

export type AiUsageDay = { day: string; calls: number; inputChars: number };
export type AiTurn = { role: "user" | "assistant"; text: string };

export type AiExcludeMode = "none" | "self" | "subtree";

/** has_api_key 반환(계약-AI 1.4). */
export type KeyStatus = { present: boolean; last4: string | null };

/** 계약-AI 4.1에서 AppError.kind에 덧붙인 것. */
export type AiErrorKind =
  | "NoApiKey"
  | "Keyring"
  | "Offline"
  | "AiTimeout"
  | "AiAuth"
  | "AiCredit"
  | "AiRateLimit"
  | "AiOverloaded"
  | "AiApi"
  | "AiExcluded"
  | "AiDailyLimit"
  | "InputTooLong"
  | "AiBusy"
  | "Cancelled";

/** 한 번에 보내는 입력 상한(유니코드 문자 수, F-08.5). 바꿀 수 없다. */
export const AI_INPUT_LIMIT = 20_000;

export type AiRequestBase = { requestId: string; pageId: PageId; today: string };
