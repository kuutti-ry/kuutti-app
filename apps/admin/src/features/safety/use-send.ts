import type { PlainMessageKey } from "@kuutti/i18n";
import { useRef, useState } from "react";
import type { z } from "zod";

// A confirm step's request (#308, #312): one at a time, its refusal in
// words, a 403 left to the shell (#302), and the parsed answer handed on.
// Shared by the sanctions' steps and a report's decision.

/** What the typed client answers. */
export type Answer = { data?: unknown; error?: unknown; response: Response };

/** The refusals a route answers with a code of their own, in words, and the words for any other failure. */
export type Refusals = {
  codes: Readonly<Record<string, PlainMessageKey>>;
  failed: PlainMessageKey;
};

/** What a request came to: done with its parsed answer, refused in words, or left to the shell (a 403). */
type Outcome<T> =
  | { kind: "done"; value: T }
  | { kind: "refused"; code: string | undefined; message: PlainMessageKey }
  | { kind: "shell" };

export async function outcomeOf<T>(
  request: Promise<Answer>,
  answer: z.ZodType<T>,
  refusals: Refusals,
): Promise<Outcome<T>> {
  const settled = await request.catch(() => null);
  if (settled?.response.status === 403) return { kind: "shell" };
  const parsed = answer.safeParse(settled?.data);
  if (parsed.success) return { kind: "done", value: parsed.data };
  const code = (settled?.error as { error?: { code?: string } } | undefined)?.error?.code;
  return { kind: "refused", code, message: (code && refusals.codes[code]) || refusals.failed };
}

/**
 * The form's end: the refusal in words, and one request at a time. The
 * buttons stay enabled while it is out, so the focus never leaves the dialog
 * for the page's body (a disabled button loses it); a second press is a no-op.
 */
export function useSend<T>({
  answer,
  refusals,
  onShell,
  onDone,
  onRefused,
}: {
  answer: z.ZodType<T>;
  refusals: Refusals;
  onShell: () => void;
  onDone: (value: T) => Promise<void>;
  /** A refusal's code, for a step whose page changes with it (a report decided meanwhile, #312). */
  onRefused?: (code: string | undefined) => void;
}) {
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<PlainMessageKey | null>(null);
  const out = useRef(false);
  const send = async (request: () => Promise<Answer>) => {
    if (out.current) return;
    out.current = true;
    setSending(true);
    setRefused(null);
    const outcome = await outcomeOf(request(), answer, refusals);
    out.current = false;
    setSending(false);
    if (outcome.kind === "shell") return onShell();
    if (outcome.kind === "refused") {
      setRefused(outcome.message);
      return onRefused?.(outcome.code);
    }
    await onDone(outcome.value);
  };
  return { sending, refused, send };
}
