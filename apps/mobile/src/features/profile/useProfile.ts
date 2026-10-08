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
      setDraft(response.profile ? toUpdate(response.profile) : EMPTY_PROFILE);
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
      if (stored) setDraft((current) => (current === submitted ? toUpdate(stored) : current));
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

  return { status, draft, completeness, saving, notice, update, save, reload: load, dismissNotice };
}
