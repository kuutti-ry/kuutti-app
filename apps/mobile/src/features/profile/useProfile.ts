import type { Completeness, ProfileDocument, ProfileUpdate, TipKind } from "@kuutti/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fetchProfile, saveProfile } from "./client";

export type ProfileNotice = { kind: "error"; code: string | undefined } | null;

/** A draft the API refused after its screen had gone, and why (#238): a screen opened with it resumes there. */
export type HeldDraft = { draft: ProfileUpdate; notice: NonNullable<ProfileNotice> };

export const EMPTY_PROFILE: ProfileUpdate = {
  displayName: "",
  bio: null,
  bioPreset: null,
  fields: {},
  prompts: [],
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
});

/**
 * The person's profile as a draft they edit and save whole (#47): the API
 * stores the document, answers it back with what is still missing, and the
 * screen shows both. A prompt without an answer yet is kept in the draft and
 * left out of the save. The tips of #56 ride along and refresh with each
 * read (the list of #227 reloads after a section or photos change). Given a
 * held draft, the first read puts it back over the stored document, with the
 * reason it was refused.
 */
export function useProfile(held?: HeldDraft) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState<ProfileUpdate>(EMPTY_PROFILE);
  /** The document as the API last gave it, in the draft's shape. */
  const [saved, setSaved] = useState<ProfileUpdate>(EMPTY_PROFILE);
  const [completeness, setCompleteness] = useState<Completeness | null>(null);
  const [tips, setTips] = useState<readonly TipKind[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ProfileNotice>(null);
  const mounted = useRef(true);
  const resume = useRef(held);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A read again (the list of #227 back in front after a section saved) keeps
  // what is shown until the answer is there, and a failed one takes nothing
  // away that was known, as the gate's read does.
  const load = useCallback(async () => {
    setStatus((was) => (was === "ready" ? was : "loading"));
    try {
      const response = await fetchProfile();
      if (!mounted.current) return;
      const document = response.profile ? toUpdate(response.profile) : EMPTY_PROFILE;
      const resumed = resume.current;
      resume.current = undefined;
      setDraft(resumed?.draft ?? document);
      setSaved(document);
      if (resumed) setNotice(resumed.notice);
      setCompleteness(response.completeness);
      setTips(response.tips);
      setStatus("ready");
    } catch {
      if (mounted.current) setStatus((was) => (was === "ready" ? was : "error"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((patch: Partial<ProfileUpdate>) => {
    setNotice(null);
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  /**
   * Saves the draft; null when the API took it, else why not, which the notice
   * also says while the screen is there. A screen already gone gets the answer
   * all the same (#238).
   */
  const save = useCallback(async (): Promise<ProfileNotice> => {
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
      if (!mounted.current) return null;
      // The stored document replaces the draft only if nothing was typed while
      // the save was in flight; otherwise those keystrokes would vanish.
      const stored = response.profile;
      if (stored) {
        const document = toUpdate(stored);
        setSaved(document);
        setDraft((current) => (current === submitted ? document : current));
      }
      setCompleteness(response.completeness);
      setTips(response.tips);
      return null;
    } catch (error) {
      const refusal = {
        kind: "error",
        code: error instanceof ApiError ? error.code : undefined,
      } as const;
      if (mounted.current) setNotice(refusal);
      return refusal;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [draft]);

  /** Whether the draft differs from what is saved: what leaving the screen would lose. */
  const dirty = canonical(draft) !== canonical(saved);

  return {
    status,
    draft,
    saved,
    completeness,
    tips,
    saving,
    notice,
    dirty,
    update,
    save,
    reload: load,
  };
}
