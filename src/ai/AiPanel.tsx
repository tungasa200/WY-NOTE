// AI 패널(화면설계 S-07, F-08.1~F-08.3·F-08.5). 앱 셸의 오른쪽 자리(aside) 안을 채운다.
// 결과는 사용자가 "바꾸기"·"삽입"을 누르기 전에는 노트에 들어가지 않는다. 요청 중에도 편집은 막지 않는다.
import { X } from "lucide-react";
import { memo, useEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AI_FAIL, errorKind, errorReason } from "../api";
import { aiApi } from "../api/ai";
import type { PageId } from "../lib/db-types";
import { AI_INPUT_LIMIT, type AiResult, type AiStatus } from "../lib/ai-types";
import { charCount, incompleteReason, localDay, pickHistory, untilMidnight } from "./aiLogic";
import type { AiTarget, Snapshot, Watch } from "./editorTarget";
import { notifyAiStatusChanged, useAiStatus, useOnline } from "./useAiStatus";
import "./AiPanel.css";

type Tab = "summarize" | "rewrite" | "ask";
const TABS: { id: Tab; label: string }[] = [
  { id: "summarize", label: "요약" },
  { id: "rewrite", label: "다듬기" },
  { id: "ask", label: "질문" },
];

type Run = "streaming" | "done" | "stopped" | "error";

type SelResult = {
  /** 요청 id. 늦게 온 응답이 새 결과를 덮지 않게 맞춰 본다. */
  id: string;
  /** 요청한 페이지. 다른 페이지에서는 보이지 않는다(페이지를 바꾼 첫 화면에서도). */
  page: PageId;
  snap: Snapshot;
  /** 다듬기만: 바꾸기 범위를 지켜본다. 요약은 바꾸지 않으므로 없다. */
  watch?: Watch;
  text: string;
  state: Run;
  truncated: boolean;
  /** 정상 완료가 아닌 끝남(거부·문맥 초과)의 안내. 있으면 노트에 넣지 않고 복사만 둔다. */
  incomplete?: string | null;
  error?: string;
  stale: boolean;
  /** 바꾸기를 이미 했다(그 뒤로는 stale이지만 원문이 바뀐 안내 대신 완료 안내). */
  replaced?: boolean;
  /** 바꾸기를 Ctrl+Z로 되돌렸다. 삽입은 다시 켜고 바꾸기는 꺼 두며 안내는 띄우지 않는다(pm 결정). */
  undone?: boolean;
  /** 바꾼 채로 편집기가 없어졌다(실행 취소 기록도 없음). 되돌리기 안내를 뺀다. */
  settled?: boolean;
};

type Msg = {
  id: string;
  question: string;
  answer: string;
  state: Run;
  truncated: boolean;
  incomplete?: string | null;
  error?: string;
  /** 이 질문에 넣지 못한 앞 대화 수 */
  dropped: number;
  /** 대상 설명(전체·선택) */
  target: string;
};

// 대화는 페이지마다 따로, 앱을 끄면 지워진다(DB에 저장하지 않음, F-08.3). 패널을 닫았다 열어도 남게 모듈에 둔다.
const conversations = new Map<PageId, Msg[]>();
let lastTab: Tab = "summarize";

// 요약·다듬기 결과도 패널을 닫았다 열어도 남게 모듈에 둔다(D-36과 같은 원칙, pm 결정). 지금 열린 패널만 다시 그린다.
// 다듬기의 지켜보기(watch)는 패널을 닫아도 풀지 않는다. 다른 페이지로 가면 편집기가 없어지며 저절로 멈춘다.
type ResultKey = "summary" | "rewrite";
const results: Record<ResultKey, SelResult | null> & { page: PageId | null } = { summary: null, rewrite: null, page: null };
let redraw: (() => void) | null = null;
const setResult = (key: ResultKey, next: SelResult | null | ((r: SelResult | null) => SelResult | null)) => {
  results[key] = typeof next === "function" ? next(results[key]) : next;
  redraw?.();
};
const setSummary = (next: Parameters<typeof setResult>[1]) => setResult("summary", next);
const setRewrite = (next: Parameters<typeof setResult>[1]) => setResult("rewrite", next);

const fmt = (n: number) => n.toLocaleString("ko-KR");

type Props = {
  /** 열린 페이지. 없으면(빈 상태·휴지통) 작업 버튼이 꺼진다. */
  pageId: PageId | null;
  /** 열린 페이지의 편집기(createEditorTarget). 편집기가 아직 없으면 null. */
  target: AiTarget | null;
  onClose: () => void;
  onOpenSettings: () => void;
};

/** 앱 셸은 저장 상태가 바뀔 때마다 다시 그려진다. props가 그대로면 패널은 다시 그리지 않는다. */
export const AiPanel = memo(function AiPanel({ pageId, target, onClose, onOpenSettings }: Props) {
  const online = useOnline();
  const { status, failed, refresh } = useAiStatus(pageId);
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [busy, setBusyState] = useState<{ id: string; tab: Tab } | null>(null);
  // 두 번 빠르게 눌러도 요청이 하나만 나가게, 다시 그리기를 기다리지 않는 ref로 막는다.
  const busyRef = useRef(busy);
  const setBusy = (b: typeof busy) => {
    busyRef.current = b;
    setBusyState(b);
  };
  useEffect(() => {
    redraw = rerender;
    return () => {
      if (redraw === rerender) redraw = null;
    };
  }, []);
  const { summary, rewrite } = results;
  const [question, setQuestion] = useState("");
  const [askNotice, setAskNotice] = useState("");
  const [live, setLive] = useState("");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // 선택은 편집할 때마다 바뀐다. 본문 길이(문서 전체 평문)는 질문 탭에서만 쓰므로 그때만,
  // 입력이 잠깐 멈췄을 때 센다(NF-04: 5만 자 문서에서 키마다 전체 평문을 만들지 않게).
  const [sel, setSel] = useState<Snapshot | null>(null);
  const [docLen, setDocLen] = useState(0);
  const needDocLen = tab === "ask";
  useEffect(() => {
    if (!target) {
      setSel(null);
      setDocLen(0);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readLen = () => setDocLen(charCount(target.docText()));
    const read = (docChanged: boolean) => {
      // 같은 선택이면 이전 값을 그대로 둬 패널을 다시 그리지 않는다(글자 입력마다 불린다).
      const next = target.selection();
      setSel((prev) => (prev && next && prev.from === next.from && prev.to === next.to && prev.text === next.text ? prev : next));
      if (docChanged && needDocLen) {
        clearTimeout(timer);
        timer = setTimeout(readLen, DOC_LEN_DELAY_MS);
      }
    };
    read(false);
    if (needDocLen) readLen();
    const off = target.subscribe(read);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [target, needDocLen]);

  // 페이지를 바꾸거나 패널을 닫으면 진행 중인 요청을 멈춘다(받을 곳이 없으면 크레딧만 쓴다).
  // 설정·휴지통에 갔다가 같은 페이지로 돌아오면 받은 요약·다듬기 결과는 남기고, 다른 페이지를 열면 버린다(pm 결정).
  // 대화는 페이지별로 남는다. 패널을 닫았다 열어도 결과는 남고, 연 페이지가 결과의 페이지와 다르면 버린다.
  useEffect(() => {
    if (pageId !== null && pageId !== results.page) {
      results.page = pageId;
      results.rewrite?.watch?.dispose();
      setSummary(null);
      setRewrite(null);
      setAskNotice("");
    }
    return () => {
      if (busyRef.current) void aiApi.cancel(busyRef.current.id).catch(() => {});
    };
  }, [pageId]);

  const messages = pageId === null ? [] : (conversations.get(pageId) ?? []);
  const updateConv = (pid: PageId, fn: (list: Msg[]) => Msg[]) => {
    conversations.set(pid, fn(conversations.get(pid) ?? []));
    rerender();
  };

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.answer]);

  // 상태 알림(S-07, 한 번에 하나, 우선순위 순).
  const blocked: "loading" | "nopage" | "nokey" | "excluded" | "offline" | "limit" | null =
    pageId === null || !target
      ? "nopage"
      : !status
        ? "loading"
        : !status.hasKey
          ? "nokey"
          : status.excluded !== "none"
            ? "excluded"
            : !online
              ? "offline"
              : status.todayCalls >= status.dailyLimit
                ? "limit"
                : null;
  const canRun = blocked === null && busy === null;

  // 오늘 상한일 때 남은 시간은 1분마다 다시 그린다.
  useEffect(() => {
    if (blocked !== "limit") return;
    const t = setInterval(rerender, 60_000);
    return () => clearInterval(t);
  }, [blocked]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setLive("복사했습니다");
    } catch {
      setLive("복사하지 못했습니다");
    }
    setTimeout(() => setLive(""), 1500);
  };

  const afterRequest = (e?: unknown) => {
    setBusy(null);
    const k = e === undefined ? null : errorKind(e);
    // 횟수·키·제외 상태가 바뀌었을 수 있다. 열린 설정 화면(오늘 n회·사용 기록)도 같이 다시 읽게 알린다.
    if (k !== "Offline") notifyAiStatusChanged();
  };

  /** 요약·다듬기: 요청 때 선택 범위를 기준으로 한다(D-28). */
  const runSelection = async (which: "summarize" | "rewrite") => {
    if (!target || pageId === null || !canRun || busyRef.current) return;
    const snap = target.selection();
    if (!snap || charCount(snap.text) > AI_INPUT_LIMIT) return;
    const set = which === "summarize" ? setSummary : setRewrite;
    const requestId = crypto.randomUUID();
    // 바꾸기는 다듬기에만 있다. 요약은 범위를 지켜보지 않는다.
    const watch =
      which === "rewrite"
        ? target.watch(snap, () => set((r) => (r && r.id === requestId ? { ...r, stale: true } : r)))
        : undefined;
    set((old) => {
      old?.watch?.dispose();
      return { id: requestId, page: pageId, snap, watch, text: "", state: "streaming", truncated: false, stale: false };
    });
    setBusy({ id: requestId, tab: which });
    const patch = (p: Partial<SelResult>) => set((r) => (r && r.id === requestId ? { ...r, ...p } : r));
    // 응답이 끝난 뒤 늦게 온 조각은 버린다(Channel 순서는 invoke 응답과 보장되지 않는다).
    const onDelta = (t: string) => set((r) => (r && r.id === requestId && r.state === "streaming" ? { ...r, text: r.text + t } : r));
    const req = { requestId, pageId, today: localDay(), text: snap.text };
    try {
      const res: AiResult = await (which === "summarize" ? aiApi.summarize(req, onDelta) : aiApi.rewrite(req, onDelta));
      patch({ text: res.text, truncated: res.truncated, incomplete: incompleteReason(res.stopReason), state: "done" });
      afterRequest();
    } catch (e) {
      if (errorKind(e) === "Cancelled") patch({ state: "stopped" });
      else patch({ state: "error", error: errorReason(e, AI_FAIL) });
      afterRequest(e);
    }
  };

  /** 질의응답 대상: 본문이 2만 자 이하면 전체, 넘으면 선택 영역(F-08.3). */
  const askTargetFor = (len: number): { label: string; text: () => string } | null =>
    !target
      ? null
      : len <= AI_INPUT_LIMIT
        ? { label: `대상: 이 페이지 전체 · ${fmt(len)}자`, text: () => target.docText() }
        : sel
          ? { label: `대상: 선택 영역 ${fmt(charCount(sel.text))}자`, text: () => target.selection()?.text ?? "" }
          : null;
  const overDoc = docLen > AI_INPUT_LIMIT;
  const askTarget = askTargetFor(docLen);

  const send = async () => {
    const q = question.trim();
    if (!q || pageId === null || !canRun || !target || busyRef.current) return;
    // 화면의 길이는 입력이 멈춘 뒤에 센다. 보낼 때는 지금 본문으로 대상을 다시 정한다(붙여넣은 직후 Enter).
    const len = charCount(target.docText());
    const askTarget = askTargetFor(len);
    if (!askTarget) {
      setDocLen(len); // 넘은 길이를 바로 반영해 '20,000자를 넘어' 안내를 띄운다.
      return;
    }
    const context = askTarget.text();
    // 실패·중지로 중간에 끊긴 답과 정상으로 끝나지 않은 답(거부 등)은 완성된 답처럼 보내지 않는다.
    const pairs = messages.filter((m) => m.state === "done" && !m.incomplete).map((m) => ({ question: m.question, answer: m.answer }));
    const pick = pickHistory(context, q, pairs);
    if (!pick) {
      setAskNotice("질문과 대상을 합쳐 20,000자를 넘습니다. 본문에서 더 좁게 선택하세요. 자동으로 잘라 보내지 않습니다.");
      return;
    }
    setAskNotice("");
    const requestId = crypto.randomUUID();
    const pid = pageId;
    const msg: Msg = {
      id: requestId,
      question: q,
      answer: "",
      state: "streaming",
      truncated: false,
      dropped: pick.dropped,
      target: askTarget.label,
    };
    updateConv(pid, (l) => [...l, msg]);
    setQuestion("");
    setBusy({ id: requestId, tab: "ask" });
    const patch = (p: Partial<Msg> | ((m: Msg) => Partial<Msg>)) =>
      updateConv(pid, (l) => l.map((m) => (m.id === requestId ? { ...m, ...(typeof p === "function" ? p(m) : p) } : m)));
    try {
      const res = await aiApi.ask(
        { requestId, pageId: pid, today: localDay(), context, history: pick.history, question: q },
        (t) => patch((m) => (m.state === "streaming" ? { answer: m.answer + t } : {})),
      );
      patch({ answer: res.text, truncated: res.truncated, incomplete: incompleteReason(res.stopReason), state: "done" });
      afterRequest();
    } catch (e) {
      if (errorKind(e) === "Cancelled") patch({ state: "stopped" });
      else patch({ state: "error", error: errorReason(e, AI_FAIL) });
      afterRequest(e);
    }
  };

  const stop = () => {
    if (busy) void aiApi.cancel(busy.id).catch(() => {});
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = TABS.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to].id);
    tabRefs.current[to]?.focus();
  };

  const selLen = sel ? charCount(sel.text) : 0;
  const selOver = selLen > AI_INPUT_LIMIT;
  // 삽입은 정상 완료면 된다(새 블록으로 넣으니 원문이 바뀌어도 괜찮다). 바꾸기는 그 뒤 원문이 그대로일 때만.
  // 결과는 요청한 페이지에서만 보인다. 설정·휴지통에 있는 동안은 숨기고, 같은 페이지로 돌아오면 다시 보인다.
  const shownSummary = summary?.page === pageId ? summary : null;
  const shownRewrite = rewrite?.page === pageId ? rewrite : null;
  // 삽입은 정상 완료면 된다(새 블록으로 넣으니 원문이 바뀌어도 괜찮다). 바꾸기는 그 뒤 원문이 그대로일 때만.
  // 이미 바꾸기를 했으면 같은 글이 두 번 들어가지 않게 삽입도 끈다.
  const canInsertRewrite = !!target && !!shownRewrite && !shownRewrite.replaced && insertable(shownRewrite, shownRewrite.text);
  const canReplace = canInsertRewrite && !shownRewrite?.stale;

  return (
    <div className="ai">
      <div className="ai-head">
        <h2 className="ai-title">AI</h2>
        {status && (
          <span className="ai-usage" title="오늘 호출 수 / 하루 상한">
            오늘 {status.todayCalls} / {status.dailyLimit}
          </span>
        )}
        {!online && <span className="ai-badge ai-badge-offline">오프라인</span>}
        <button type="button" className="icon-button ai-close" aria-label="AI 패널 닫기" aria-keyshortcuts="Control+J" title="AI 패널 닫기 (Ctrl+J)" onClick={onClose}>
          <X size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" />
        </button>
      </div>

      <div className="ai-tabs" role="tablist" aria-label="AI 작업">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`ai-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="ai-tabpanel"
            tabIndex={tab === t.id ? 0 : -1}
            className="ai-tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Notice blocked={blocked} failed={failed} status={status} onOpenSettings={onOpenSettings} onRetry={() => void refresh()} />

      <div className="ai-body" id="ai-tabpanel" role="tabpanel" aria-labelledby={`ai-tab-${tab}`}>
        {tab === "summarize" && (
          <SelectionTask
            verb="요약하기"
            empty="본문에서 요약할 부분을 선택하세요"
            selLen={selLen}
            selOver={selOver}
            canRun={canRun && !!sel && !selOver}
            running={busy?.tab === "summarize"}
            otherBusy={busy !== null && busy.tab !== "summarize"}
            onRun={() => void runSelection("summarize")}
            onStop={stop}
          >
            {shownSummary && (
              <ResultCard
                result={shownSummary}
                onRetry={canRun && sel && !selOver ? () => void runSelection("summarize") : undefined}
                actions={
                  <>
                    <button
                      type="button"
                      className="button"
                      disabled={!target || !insertable(shownSummary, shownSummary.text)}
                      onClick={() => target?.insertBelow(shownSummary.text)}
                    >
                      삽입
                    </button>
                    <CopyButton text={shownSummary.text} disabled={shownSummary.state === "streaming"} onCopy={copy} />
                  </>
                }
              />
            )}
          </SelectionTask>
        )}

        {tab === "rewrite" && (
          <SelectionTask
            verb="다듬기"
            empty="본문에서 다듬을 부분을 선택하세요"
            selLen={selLen}
            selOver={selOver}
            canRun={canRun && !!sel && !selOver}
            running={busy?.tab === "rewrite"}
            otherBusy={busy !== null && busy.tab !== "rewrite"}
            onRun={() => void runSelection("rewrite")}
            onStop={stop}
          >
            {shownRewrite && (
              <ResultCard
                result={shownRewrite}
                original={shownRewrite.snap.text}
                onRetry={canRun && sel && !selOver ? () => void runSelection("rewrite") : undefined}
                actions={
                  <>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={!canReplace}
                      onClick={() => {
                        const id = shownRewrite.id;
                        const ok = shownRewrite.watch?.replace(shownRewrite.text, (s) =>
                          setRewrite((r) =>
                            r && r.id === id ? (s === "settled" ? { ...r, settled: true } : { ...r, replaced: s === "replaced", undone: s === "undone" }) : r,
                          ),
                        );
                        if (ok) setRewrite((r) => (r && r.id === id ? { ...r, stale: true, replaced: true } : r));
                      }}
                    >
                      바꾸기
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={!canInsertRewrite}
                      onClick={() => target?.insertBelow(shownRewrite.text)}
                    >
                      삽입
                    </button>
                    <CopyButton text={shownRewrite.text} disabled={shownRewrite.state === "streaming"} onCopy={copy} />
                  </>
                }
              />
            )}
          </SelectionTask>
        )}

        {tab === "ask" && (
          <div className="ai-ask">
            <p className="ai-target">{askTarget ? askTarget.label : target ? `대상: 이 페이지 전체 · ${fmt(docLen)}자` : ""}</p>
            {blocked === null && overDoc && !sel && (
              <p className="ai-notice ai-notice-neutral" role="status">
                이 노트는 20,000자를 넘어 전체를 보낼 수 없습니다. 질문할 부분을 본문에서 선택하세요. 자동으로 잘라 보내지 않습니다.
              </p>
            )}
            <div className="ai-log" ref={logRef} aria-live="polite" aria-busy={busy?.tab === "ask"}>
              {(messages[messages.length - 1]?.dropped ?? 0) > 0 && (
                <p className="ai-dropped">앞 대화 {messages[messages.length - 1]!.dropped}개는 이번 질문에 포함되지 않음</p>
              )}
              {messages.length === 0 && <p className="ai-empty">이 페이지 내용을 바탕으로 답합니다. 대화는 앱을 끄면 지워집니다.</p>}
              {messages.map((m) => (
                <div key={m.id} className="ai-turn">
                  <p className="ai-q">{m.question}</p>
                  <div className="ai-a">
                    {m.answer && <p className="ai-text">{m.answer}</p>}
                    {m.state === "streaming" && (
                      <span className="ai-dots" role="status" aria-label="답을 받는 중">
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                    {m.state === "stopped" && <p className="ai-meta">중지했습니다</p>}
                    {m.truncated && <EndNote badge="잘림" reason={TRUNCATED} hasText={!!m.answer.trim()} />}
                    {m.incomplete && <EndNote badge="끝나지 않음" reason={m.incomplete} hasText={!!m.answer.trim()} />}
                    {m.state === "error" && <FailAlert reason={m.error!} />}
                    {m.answer && m.state !== "streaming" && (
                      <div className="ai-actions">
                        <button type="button" className="button" onClick={() => target?.insertBelow(m.answer)} disabled={!target || !insertable(m, m.answer)}>
                          삽입
                        </button>
                        <CopyButton text={m.answer} onCopy={copy} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {askNotice && (
              <p className="ai-notice ai-notice-neutral" role="status">
                {askNotice}
              </p>
            )}
            <div className="ai-compose">
              <textarea
                className="ai-input"
                aria-label="질문"
                rows={3}
                placeholder={blocked === "excluded" ? "AI 전송 제외 페이지입니다" : "이 페이지에 대해 질문하기"}
                disabled={blocked !== null && blocked !== "loading"}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="ai-compose-row">
                <span className="ai-hint">Enter 보내기 · Shift+Enter 줄바꿈</span>
                <button
                  type="button"
                  className="button ai-small"
                  disabled={messages.length === 0 || busy?.tab === "ask"}
                  onClick={() => pageId !== null && updateConv(pageId, () => [])}
                >
                  새 대화
                </button>
                {/* 보내기와 중지는 같은 자리·같은 요소다. 끝나면 입력칸이 비어 못 누르게 되지만 disabled 대신 aria-disabled라 포커스가 남는다. */}
                <button
                  type="button"
                  className={busy?.tab === "ask" ? "button ai-send" : "button button-primary ai-send"}
                  aria-disabled={busy?.tab !== "ask" && (!canRun || !askTarget || !question.trim())}
                  onClick={busy?.tab === "ask" ? stop : () => void send()}
                >
                  {busy?.tab === "ask" ? "중지" : "보내기"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <p className="ai-live" role="status">
        {live}
      </p>
    </div>
  );
});

function Notice({
  blocked,
  failed,
  status,
  onOpenSettings,
  onRetry,
}: {
  blocked: string | null;
  failed: boolean;
  status: AiStatus | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  if (blocked === "loading" && failed)
    return (
      <div className="ai-notice ai-notice-danger" role="alert">
        <span>AI 상태를 읽지 못했습니다.</span>
        <button type="button" className="button ai-small" onClick={onRetry}>
          다시 읽기
        </button>
      </div>
    );
  switch (blocked) {
    case "nopage":
      return <p className="ai-notice ai-notice-neutral">페이지를 열면 AI를 쓸 수 있습니다.</p>;
    case "nokey":
      return (
        <div className="ai-notice ai-notice-neutral" role="status">
          <span>API 키 없음. 설정에서 Claude API 키를 등록하면 AI를 쓸 수 있습니다.</span>
          <button type="button" className="button ai-small" onClick={onOpenSettings}>
            설정 열기
          </button>
        </div>
      );
    case "excluded":
      return (
        <p className="ai-notice ai-notice-neutral" role="status">
          {status?.excluded === "ancestor"
            ? "상위 페이지가 하위 포함으로 AI 전송 제외되어 이 페이지의 내용은 보내지 않습니다."
            : status?.excludeMode === "subtree"
              ? "AI 전송 제외 페이지입니다(하위 페이지 포함). 이 페이지와 하위 페이지의 내용은 보내지 않습니다."
              : "AI 전송 제외 페이지입니다(이 페이지만). 이 페이지의 내용은 보내지 않습니다."}
        </p>
      );
    case "offline":
      return (
        <p className="ai-notice ai-notice-warning" role="status">
          오프라인입니다. 인터넷에 다시 연결되면 자동으로 켜집니다.
        </p>
      );
    case "limit":
      return (
        <p className="ai-notice ai-notice-warning" role="status">
          오늘 상한 도달({status?.dailyLimit}회). 자정까지 {untilMidnight()} 남았습니다. 상한은 설정에서 바꿀 수 있습니다.
        </p>
      );
    default:
      return null;
  }
}

function SelectionTask({
  verb,
  empty,
  selLen,
  selOver,
  canRun,
  running,
  otherBusy,
  onRun,
  onStop,
  children,
}: {
  verb: string;
  empty: string;
  selLen: number;
  selOver: boolean;
  canRun: boolean;
  running: boolean;
  otherBusy: boolean;
  onRun: () => void;
  onStop: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ai-task">
      <div className="ai-task-row">
        <p className="ai-target">{selLen ? `대상: 선택 영역 · ${fmt(selLen)}자` : empty}</p>
        {/* 실행과 중지는 같은 요소다. 끝난 뒤 선택이 없어져도 포커스가 남게 disabled 대신 aria-disabled를 쓴다. */}
        <button
          type="button"
          className={running ? "button ai-run" : "button button-primary ai-run"}
          aria-disabled={!running && !canRun}
          onClick={running ? onStop : canRun ? onRun : undefined}
        >
          {running ? "중지" : verb}
        </button>
      </div>
      {selOver && (
        <p className="ai-notice ai-notice-neutral" role="status">
          선택이 20,000자를 넘습니다({fmt(selLen)}자). 범위를 줄이세요. 자동으로 잘라 보내지 않습니다.
        </p>
      )}
      {otherBusy && <p className="ai-hint">다른 AI 작업이 끝나면 할 수 있습니다.</p>}
      {children}
    </div>
  );
}

function ResultCard({
  result,
  original,
  actions,
  onRetry,
}: {
  result: SelResult;
  original?: string;
  actions: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <section className="ai-card" aria-label="결과" aria-busy={result.state === "streaming"}>
      {original !== undefined && (
        <>
          <h3 className="ai-card-label">원문</h3>
          <p className="ai-text ai-original">{original}</p>
          <h3 className="ai-card-label">다듬은 글</h3>
        </>
      )}
      {result.text && <p className="ai-text">{result.text}</p>}
      {result.state === "streaming" && (
        <span className="ai-dots" role="status" aria-label="결과를 받는 중">
          <span />
          <span />
          <span />
        </span>
      )}
      {result.state === "stopped" && <p className="ai-meta">중지했습니다</p>}
      {result.truncated && <EndNote badge="잘림" reason={TRUNCATED} hasText={!!result.text.trim()} />}
      {result.incomplete && <EndNote badge="끝나지 않음" reason={result.incomplete} hasText={!!result.text.trim()} />}
      {result.replaced ? (
        <p className="ai-meta">{result.settled ? "바꿨습니다." : "바꿨습니다. Ctrl+Z로 되돌릴 수 있습니다."}</p>
      ) : (
        result.stale &&
        !result.undone &&
        original !== undefined &&
        result.state !== "streaming" && <p className="ai-meta">요청한 뒤 원문이 바뀌었거나 페이지를 다시 열어 바꾸기를 할 수 없습니다.</p>
      )}
      {result.state === "error" && <FailAlert reason={result.error!} onRetry={onRetry} />}
      {result.text && <div className="ai-actions">{actions}</div>}
    </section>
  );
}

const TRUNCATED = "출력 상한에 걸려 결과가 잘렸습니다";
// 질문 탭의 본문 길이를 입력이 멈춘 뒤 이만큼 지나 센다.
const DOC_LEN_DELAY_MS = 250;

/**
 * 정상 완료(end_turn·stop_sequence)로 끝난 결과만 노트에 넣는다. 잘림·거부·문맥 초과·중지·실패는 복사만(D-31).
 * 다듬기의 바꾸기도 이 조건을 따른다.
 */
function insertable(r: { state: Run; truncated: boolean; incomplete?: string | null }, text: string) {
  return r.state === "done" && !r.truncated && !r.incomplete && !!text.trim();
}

/** 정상 완료가 아닌 끝남(S-07 끝난 이유). 거부는 글 없이 끝나기도 한다. 그때는 복사할 것도 없으므로 노트가 그대로라는 것만 알린다. */
function EndNote({ badge, reason, hasText }: { badge: string; reason: string; hasText: boolean }) {
  return (
    <p className="ai-meta">
      <span className="ai-badge">{badge}</span> {reason}.{" "}
      {hasText ? "노트에 넣을 수 없어 복사만 할 수 있습니다." : "노트는 바뀌지 않았습니다."}
    </p>
  );
}

function FailAlert({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  return (
    <div className="ai-notice ai-notice-danger" role="alert">
      <span>
        {reason}. 노트는 바뀌지 않았습니다.
      </span>
      {onRetry && (
        <button type="button" className="button ai-small" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

function CopyButton({ text, disabled, onCopy }: { text: string; disabled?: boolean; onCopy: (t: string) => void }) {
  return (
    <button type="button" className="button" disabled={disabled || !text} onClick={() => onCopy(text)}>
      복사
    </button>
  );
}
