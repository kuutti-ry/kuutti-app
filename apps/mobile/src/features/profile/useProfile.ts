import type {
  Completeness,
  HiddenField,
  ProfileDocument,
  ProfileFields,
  ProfileUpdate,
} from "@kuutti/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fetchProfile, saveProfile } from "./client";

export type ProfileNotice = { kind: "error"; code: string | undefined } | null;

/**
 * What a draft changed from the document it was read from (#238): the parts
 * that differ, the fields one by one, a field taken away as undefined, and
 * the fields hidden (true) or shown again (false), one by one for the same
 * reason (#515).
 */
export type ProfileChanges = Partial<Omit<ProfileUpdate, "fields" | "hiddenFields">> & {
  fields?: Record<string, unknown>;
  hidden?: Record<string, boolean>;
};

/** Changes the API refused after their screen had gone, and why (#238): a screen opened with them resumes there. */
export type HeldDraft = { changes: ProfileChanges; notice: NonNullable<ProfileNotice> };

export const EMPTY_PROFILE: ProfileUpdate = {
  displayName: "",
  bio: null,
  bioPreset: null,
  fields: {},
  prompts: [],
  hiddenFields: [],
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

/** What `to` changed from `from`; nothing for the same document with its keys in another order. */
export function changesOf(from: ProfileUpdate, to: ProfileUpdate): ProfileChanges {
  const changes: ProfileChanges = {};
  if (from.displayName !== to.displayName) changes.displayName = to.displayName;
  // A bio and a ready line go together: the API takes one or the other, never both.
  if (from.bio !== to.bio || from.bioPreset !== to.bioPreset) {
    changes.bio = to.bio;
    changes.bioPreset = to.bioPreset;
  }
  if (canonical(from.prompts) !== canonical(to.prompts)) changes.prompts = to.prompts;
  const was = from.fields as Record<string, unknown>;
  const is = to.fields as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (canonical(was[key]) !== canonical(is[key])) fields[key] = is[key];
  }
  if (Object.keys(fields).length > 0) changes.fields = fields;
  const wasHidden: readonly string[] = from.hiddenFields ?? [];
  const isHidden: readonly string[] = to.hiddenFields ?? [];
  const hidden: Record<string, boolean> = {};
  for (const key of new Set([...wasHidden, ...isHidden])) {
    if (wasHidden.includes(key) !== isHidden.includes(key)) hidden[key] = isHidden.includes(key);
  }
  if (Object.keys(hidden).length > 0) changes.hidden = hidden;
  return changes;
}

/** The document with the changes put on it; what they do not name stays as the document has it. */
export function withChanges(document: ProfileUpdate, changes: ProfileChanges): ProfileUpdate {
  const { fields: changed = {}, hidden = {}, ...parts } = changes;
  const fields: Record<string, unknown> = { ...document.fields };
  for (const [key, value] of Object.entries(changed)) {
    if (value === undefined) delete fields[key];
    else fields[key] = value;
  }
  const hiddenFields = [
    ...(document.hiddenFields ?? []).filter((key) => hidden[key] === undefined),
    ...(Object.keys(hidden).filter((key) => hidden[key]) as HiddenField[]),
  ];
  return { ...document, ...parts, fields: fields as ProfileFields, hiddenFields };
}

const toUpdate = (profile: ProfileDocument): ProfileUpdate => ({
  displayName: profile.displayName,
  bio: profile.bio,
  bioPreset: profile.bioPreset,
  fields: profile.fields,
  prompts: profile.prompts,
  hiddenFields: profile.hiddenFields,
});

/**
 * The person's profile as a draft they edit (#47): the API stores the
 * document, answers it back with what is still missing, and the screen shows
 * both. A save sends what the draft changed, put on the document as stored
 * when the save goes (#238): two screens read together, a section brought
 * back over another, each keep their own change, and neither undoes the
 * other's. A prompt without an answer yet is kept in the draft and left out
 * of the save. Given held changes, the first read puts them back over the
 * stored document, with the reason they were refused.
 */
export function useProfile(held?: HeldDraft) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  /** Why the last read failed, for the screen to say so (LoadFailed); null after a read that worked. */
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<ProfileUpdate>(EMPTY_PROFILE);
  /** The document as the API last gave it, in the draft's shape. */
  const [saved, setSaved] = useState<ProfileUpdate>(EMPTY_PROFILE);
  const [completeness, setCompleteness] = useState<Completeness | null>(null);
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
      setDraft(resumed ? withChanges(document, resumed.changes) : document);
      setSaved(document);
      if (resumed) setNotice(resumed.notice);
      setCompleteness(response.completeness);
      setError(null);
      setStatus("ready");
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure);
      setStatus((was) => (was === "ready" ? was : "error"));
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
    const changes = changesOf(saved, {
      ...draft,
      displayName: draft.displayName.trim(),
      bio: draft.bio?.trim() ? draft.bio.trim() : null,
      prompts: draft.prompts
        .filter((p) => p.answer.trim().length > 0)
        .map((p) => ({ key: p.key, answer: p.answer.trim() })),
    });
    try {
      const response = await saveProfile((stored) =>
        withChanges(stored ? toUpdate(stored) : EMPTY_PROFILE, changes),
      );
      if (!mounted.current) return null;
      // The stored document becomes the draft, with anything typed while the
      // save was in flight put back on it; otherwise those keystrokes would vanish.
      const stored = response.profile;
      if (stored) {
        const document = toUpdate(stored);
        setSaved(document);
        setDraft((current) => withChanges(document, changesOf(submitted, current)));
      }
      setCompleteness(response.completeness);
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
  }, [draft, saved]);

  /** What the draft changed from what is saved: what leaving the screen would lose. */
  const changes = useMemo(() => changesOf(saved, draft), [saved, draft]);
  const dirty = Object.keys(changes).length > 0;

  return {
    status,
    error,
    draft,
    saved,
    completeness,
    saving,
    notice,
    changes,
    dirty,
    update,
    save,
    reload: load,
  };
}
