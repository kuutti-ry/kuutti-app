import type { Completeness, ProfileDocument, ProfileUpdate } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fetchProfile, saveProfile } from "./client";

export type ProfileNotice = { kind: "saved" } | { kind: "error"; code: string | undefined } | null;

export const EMPTY_PROFILE: ProfileUpdate = {
  displayName: "",
  bio: null,
  bioPreset: null,
  fields: {},
  prompts: [],
  specialCategoryConsent: null,
};

/** Key order aside: the draft is built by merging patches, the document comes from the API. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

const toUpdate = (profile: ProfileDocument): ProfileUpdate => ({
  displayName: profile.displayName,
  bio: profile.bio,
  bioPreset: profile.bioPreset,
  fields: profile.fields,
  prompts: profile.prompts,
  specialCategoryConsent: profile.specialCategoryConsent
    ? { version: profile.specialCategoryConsent.version }
    : null,
});

/**
 * The person's profile as a draft they edit and save whole (#47): the API
 * stores the document, answers it back with what is still missing, and the
 * screen shows both. A prompt without an answer yet is kept in the draft and
 * left out of the save.
 */
export function useProfile() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState<ProfileUpdate>(EMPTY_PROFILE);
  /** The document as the API last gave it, in the draft's shape. */
  const [saved, setSaved] = useState<ProfileUpdate>(EMPTY_PROFILE);
  const [completeness, setCompleteness] = useState<Completeness | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ProfileNotice>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetchProfile();
      if (!mounted.current) return;
      const document = response.profile ? toUpdate(response.profile) : EMPTY_PROFILE;
      setDraft(document);
      setSaved(document);
      setCompleteness(response.completeness);
      setStatus("ready");
    } catch {
      if (mounted.current) setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((patch: Partial<ProfileUpdate>) => {
    setNotice(null);
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  /** Saves the draft; true when the API took it, false when it refused or failed (the notice says why). */
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setNotice(null);
    const submitted = draft;
    try {
      const response = await saveProfile({
        ...submitted,
        displayName: draft.displayName.trim(),
        bio: draft.bio?.trim() ? draft.bio.trim() : null,
        prompts: draft.prompts
          .filter((p) => p.answer.trim().length > 0)
          .map((p) => ({ key: p.key, answer: p.answer.trim() })),
      });
      if (!mounted.current) return true;
      // The stored document replaces the draft only if nothing was typed while
      // the save was in flight; otherwise those keystrokes would vanish.
      const stored = response.profile;
      if (stored) {
        const document = toUpdate(stored);
        setSaved(document);
        setDraft((current) => (current === submitted ? document : current));
      }
      setCompleteness(response.completeness);
      setNotice({ kind: "saved" });
      return true;
    } catch (error) {
      if (mounted.current) {
        setNotice({ kind: "error", code: error instanceof ApiError ? error.code : undefined });
      }
      return false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [draft]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  /** Whether the draft differs from what is saved: what leaving the screen would lose. */
  const dirty = canonical(draft) !== canonical(saved);

  return {
    status,
    draft,
    saved,
    completeness,
    saving,
    notice,
    dirty,
    update,
    save,
    reload: load,
    dismissNotice,
  };
}
