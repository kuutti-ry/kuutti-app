import { PhotoUrlResponse } from "@kuutti/schema";
import { useEffect, useRef, useState } from "react";
import type { Answer } from "./use-send.ts";

/**
 * A photo hidden until asked (#253, #306, #312): the request is the audit
 * row (photo.view), so one press is one look, and the picture takes the focus
 * the button had. The button stays enabled while it asks, so a failure leaves
 * the focus on it (a disabled button loses it); a second press is a no-op.
 * A 403 is the shell's to say (#302): no failure of its own.
 */
export function usePhotoOnRequest(request: () => Promise<Answer>) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const asking = useRef(false);
  const picture = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (url) picture.current?.focus();
  }, [url]);
  const show = async () => {
    if (asking.current) return;
    asking.current = true;
    setPending(true);
    setFailed(false);
    const answer = await request().catch(() => null);
    asking.current = false;
    setPending(false);
    if (answer?.response.status === 403) return;
    const parsed = PhotoUrlResponse.safeParse(answer?.data);
    if (!parsed.success) return setFailed(true);
    setUrl(parsed.data.url);
  };
  return { url, failed, pending, show, picture };
}
