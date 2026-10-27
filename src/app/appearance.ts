// 테마·강조색(S-08 화면, P5-2). 저장의 기준은 ui_state(theme·accent)이고,
// localStorage에는 앱을 켤 때 번쩍이지 않게 public/theme-init.js가 먼저 읽을 사본만 둔다.
import type { Accent, Theme, UiState } from "../lib/db-types";

export type Appearance = { theme: Theme; accent: Accent };

export const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "Windows 설정 따름" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

export const ACCENTS: { value: Accent; label: string }[] = [
  { value: "teal", label: "먹청록" },
  { value: "navy", label: "남색" },
  { value: "plum", label: "자주" },
  { value: "rust", label: "주황 갈색" },
  { value: "gray", label: "회색" },
];

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accent: "teal" };

const CACHE_KEY = "wy-note-appearance"; // public/theme-init.js와 같은 키

/** 저장된 값을 읽는다. 모르는 값·빠진 값은 기본값(F-09). */
export function readAppearance(v: Pick<UiState, "theme" | "accent"> | null | undefined): Appearance {
  return {
    theme: THEMES.some((t) => t.value === v?.theme) ? v!.theme! : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.some((a) => a.value === v?.accent) ? v!.accent! : DEFAULT_APPEARANCE.accent,
  };
}

/** theme-init.js가 이미 넣어 둔 값(사본). 없거나 깨졌으면 기본값. */
export function cachedAppearance(): Appearance {
  try {
    return readAppearance(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** <html>에 적용한다. 기본값(시스템·먹청록)은 속성을 지운다. */
export function applyAppearance(a: Appearance) {
  const html = document.documentElement;
  if (a.theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", a.theme);
  if (a.accent === "teal") html.removeAttribute("data-accent");
  else html.setAttribute("data-accent", a.accent);
}

/** ui_state에 있는 값(읽었거나 저장에 성공한 값)만 사본으로 남긴다. 저장에 실패한 값이 다음 시작 때 먼저 보이지 않게. */
export function cacheAppearance(a: Appearance) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(a));
  } catch {
    // 사본을 못 남기면 다음 시작 때 잠깐 기본 색으로 보일 뿐이다.
  }
}
