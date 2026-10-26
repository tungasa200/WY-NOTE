// 자동 저장(F-05, NF-02): 마지막 입력 후 1초 디바운스, 계속 입력해도 5초마다 한 번은 저장.
// 한 페이지의 저장은 앞의 호출이 끝난 뒤에 보낸다(대기열 1개, 계약 8절). 실패하면 내용을 메모리에 두고 5초 뒤 다시 보낸다.
import { api, isAppError } from "../api";
import type { JSONContent, PageId } from "../lib/db-types";

const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;
const RETRY_MS = 5000;

export type SaveStatus = { state: "saved" | "saving" } | { state: "error"; error: unknown };

class PageSaver {
  private content: JSONContent | null = null;
  private title: string | null = null;
  private firstPendingAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  /** 보내는 중인 본문. 끝나기 전에는 DB에 있다고 볼 수 없다. */
  private sending: JSONContent | null = null;
  status: SaveStatus = { state: "saved" };

  constructor(
    readonly id: PageId,
    private readonly onStatus: (s: PageSaver) => void,
  ) {}

  /** DB에 아직 들어갔다고 볼 수 없는 가장 새 본문(보내는 중인 것 포함). */
  get pendingContent() {
    return this.content ?? this.sending;
  }

  get dirty() {
    return this.content !== null || this.title !== null;
  }

  setContent(doc: JSONContent) {
    this.content = doc;
    this.schedule();
  }

  setTitle(title: string) {
    this.title = title;
    this.schedule();
  }

  private schedule(delay?: number) {
    // 실패 뒤 다시 보내기를 기다리는 중이면 입력이 와도 5초 간격을 당기지 않는다(새 내용은 그때 같이 간다).
    if (delay === undefined && this.status.state === "error" && this.timer) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    const wait = delay ?? Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - this.firstPendingAt));
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), Math.max(0, wait));
    // 실패 중에는 다시 저장할 때까지 '저장 안 됨'을 유지한다.
    if (this.status.state === "saved") this.setStatus({ state: "saving" });
  }

  /** 남은 저장을 지금 보내고, 끝날 때까지 기다린다. 앞의 저장이 진행 중이면 그 뒤에 보낸다. */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.inflight) await this.inflight;
    if (!this.dirty) return;
    const content = this.content;
    const title = this.title;
    this.content = null;
    this.title = null;
    this.firstPendingAt = null;
    this.sending = content;
    this.setStatus({ state: "saving" });
    // 제목·본문 호출을 await 없이 한꺼번에 보낸다(창 닫기·새로고침 직전 호출이 끊기지 않게).
    const calls = [
      title !== null ? api.renamePage(this.id, title) : null,
      content !== null ? api.savePage(this.id, content) : null,
    ];
    this.inflight = (async () => {
      try {
        await Promise.all(calls);
        if (!this.dirty) this.setStatus({ state: "saved" });
      } catch (error) {
        // 그사이 새 입력이 있으면 그것이 더 새 내용이다.
        this.content ??= content;
        this.title ??= title;
        this.setStatus({ state: "error", error });
        // 없는 페이지(휴지통으로 간 페이지)는 다시 보내도 같은 결과다.
        if (!(isAppError(error) && error.kind === "NotFound")) this.schedule(RETRY_MS);
      } finally {
        this.sending = null;
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  cancel() {
    this.clearTimer();
    this.content = null;
    this.title = null;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(s: SaveStatus) {
    this.status = s;
    this.onStatus(this);
  }
}

/** 페이지마다 저장기를 하나씩 둔다. 페이지를 바꿔도 앞 페이지의 실패 재시도는 계속된다. */
export class Autosaver {
  private savers = new Map<PageId, PageSaver>();

  constructor(private readonly onStatus: (id: PageId, status: SaveStatus) => void) {}

  private saver(id: PageId) {
    let s = this.savers.get(id);
    if (!s) {
      s = new PageSaver(id, (x) => {
        this.onStatus(x.id, x.status);
        if (!x.dirty && x.status.state === "saved") this.savers.delete(x.id);
      });
      this.savers.set(id, s);
    }
    return s;
  }

  setContent(id: PageId, doc: JSONContent) {
    this.saver(id).setContent(doc);
  }

  setTitle(id: PageId, title: string) {
    this.saver(id).setTitle(title);
  }

  /** 아직 저장하지 못한 본문(보내는 중인 것 포함). 실패 중 다른 화면에 갔다 돌아오면 DB 본문보다 새것이다. */
  pendingContent(id: PageId): JSONContent | null {
    return this.savers.get(id)?.pendingContent ?? null;
  }

  status(id: PageId): SaveStatus {
    return this.savers.get(id)?.status ?? { state: "saved" };
  }

  flush(id: PageId): Promise<void> {
    return this.savers.get(id)?.flush() ?? Promise.resolve();
  }

  flushAll(): Promise<void> {
    return Promise.all([...this.savers.values()].map((s) => s.flush())).then(() => undefined);
  }

  /** 아직 저장하지 못한 페이지가 있으면 그 오류(창 닫기 확인용). 없으면 undefined. */
  firstError(): unknown {
    for (const s of this.savers.values()) if (s.status.state === "error") return s.status.error;
    return undefined;
  }

  /** 아직 DB에 가지 않은 내용이 있는 페이지. */
  pendingIds(): PageId[] {
    return [...this.savers.values()].filter((s) => s.dirty || s.status.state !== "saved").map((s) => s.id);
  }

  /** 휴지통으로 보낸 페이지는 더 저장하지 않는다(save_page가 NotFound가 된다). */
  discard(ids: Iterable<PageId>) {
    for (const id of ids) {
      this.savers.get(id)?.cancel();
      this.savers.delete(id);
    }
  }
}
