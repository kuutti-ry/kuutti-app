/**
 * A stand-in for XMLHttpRequest, for tests of the photo upload: records what
 * was sent, lets the test drive progress and the answer. Installed on
 * globalThis by the test that needs it.
 */
export type FakeRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: FormData | null;
};

export class FakeXhr {
  static sent: FakeRequest[] = [];
  /** What the next request(s) answer, in order; the last one repeats. */
  static answers: Array<{ status: number; body: string; progress?: number[] }> = [];

  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = "";
  private request: FakeRequest = { method: "", url: "", headers: {}, body: null };

  open(method: string, url: string): void {
    this.request.method = method;
    this.request.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.request.headers[name.toLowerCase()] = value;
  }
  send(body: FormData | null): void {
    this.request.body = body;
    FakeXhr.sent.push(this.request);
    const answer = FakeXhr.answers.length > 1 ? FakeXhr.answers.shift() : FakeXhr.answers[0];
    if (!answer) throw new Error("FakeXhr: no answer prepared");
    setTimeout(() => {
      for (const loaded of answer.progress ?? [50, 100]) {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total: 100 });
      }
      this.status = answer.status;
      this.responseText = answer.body;
      this.onload?.();
    }, 0);
  }

  static install(): void {
    FakeXhr.sent = [];
    FakeXhr.answers = [];
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    // React Native's FormData, not Node's: it keeps a file part as { uri, name,
    // type } and exposes getParts(), which is what the runtime streams from.
    (globalThis as { FormData: unknown }).FormData =
      // biome-ignore lint/suspicious/noReactNativeDeepImports: the entry point exports no FormData
      (require("react-native/Libraries/Network/FormData") as { default: unknown }).default;
  }
}

/** The parts of a sent request's body, as React Native's FormData reports them. */
export function partsOf(request: FakeRequest | undefined): Array<Record<string, unknown>> {
  const body = request?.body as unknown as
    | { getParts?: () => Array<Record<string, unknown>> }
    | null
    | undefined;
  return body?.getParts?.() ?? [];
}
