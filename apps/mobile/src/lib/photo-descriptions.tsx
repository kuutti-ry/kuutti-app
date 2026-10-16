import { ALL_DESCRIPTION_PARTS, describePhoto, type PhotoDescriptionParts } from "@kuutti/i18n";
import type { PhotoDescription } from "@kuutti/schema";
import * as React from "react";
import { useT } from "./locale";
import { readPreference, writePreference } from "./preferences";

/**
 * The Photo descriptions setting (#296 part 3): whether the automatic
 * description is shown as text under each photo, and which of its three
 * parts are told, in the spoken label and the text alike. Kept on the device
 * with the theme and the language, never sent to the API: with the hint's
 * flag, it is the closest the app comes to knowing a person uses a screen
 * reader, and a list of such people is a list of disabled people (article 9,
 * ADR-019 §6). The description itself is always in a photo's
 * accessibilityLabel, whatever "Show under photos" says.
 */
export type PhotoDescriptionSettings = PhotoDescriptionParts & {
  /** The text under the photo on the card, in one's own photos and full size; off by default, the label needs no setting. */
  shown: boolean;
};

export const DEFAULT_PHOTO_DESCRIPTION_SETTINGS: Readonly<PhotoDescriptionSettings> = {
  shown: false,
  ...ALL_DESCRIPTION_PARTS,
};

const KEYS = ["shown", "people", "face", "objects"] as const satisfies ReadonlyArray<
  keyof PhotoDescriptionSettings
>;

/** What was stored, field by field; anything not a boolean is the default, and so is a store that holds nothing. */
export function readPhotoDescriptionSettings(raw: string | null): PhotoDescriptionSettings {
  const settings = { ...DEFAULT_PHOTO_DESCRIPTION_SETTINGS };
  if (raw === null) return settings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return settings;
  for (const key of KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "boolean") settings[key] = value;
  }
  return settings;
}

type Settings = {
  settings: PhotoDescriptionSettings;
  /** Changes what is given and keeps the rest; written to the device at once. */
  set: (change: Partial<PhotoDescriptionSettings>) => void;
};

const PhotoDescriptionsContext = React.createContext<Settings | null>(null);

/** Reads the stored choice once, below the language and the theme, and hands it to every photo and to the setting's screen. */
export function PhotoDescriptionsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<PhotoDescriptionSettings>({
    ...DEFAULT_PHOTO_DESCRIPTION_SETTINGS,
  });
  React.useEffect(() => {
    let mounted = true;
    void readPreference("photoDescriptions").then((stored) => {
      if (mounted) setSettings(readPhotoDescriptionSettings(stored));
    });
    return () => {
      mounted = false;
    };
  }, []);
  const set = React.useCallback((change: Partial<PhotoDescriptionSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...change };
      void writePreference("photoDescriptions", JSON.stringify(next));
      return next;
    });
  }, []);
  const value = React.useMemo<Settings>(() => ({ settings, set }), [settings, set]);
  return (
    <PhotoDescriptionsContext.Provider value={value}>{children}</PhotoDescriptionsContext.Provider>
  );
}

export function usePhotoDescriptionSettings(): Settings {
  const value = React.useContext(PhotoDescriptionsContext);
  if (!value) throw new Error("usePhotoDescriptionSettings needs a PhotoDescriptionsProvider");
  return value;
}

/**
 * The description of a photo in words, as the person wants it: `describe`
 * gives the text of the parts turned on, or null when there is nothing to
 * say; `label` appends it to a photo's screen-reader label, so the caption
 * is heard first and then "Automatic description: ..."; `shown` says whether
 * the same text goes under the photo for the eye.
 */
export function usePhotoDescriptionText(): {
  shown: boolean;
  describe: (description: PhotoDescription | null | undefined) => string | null;
  label: (base: string, description: PhotoDescription | null | undefined) => string;
} {
  const { t } = useT();
  const { settings } = usePhotoDescriptionSettings();
  return React.useMemo(() => {
    const describe = (description: PhotoDescription | null | undefined): string | null =>
      description ? describePhoto(t, description, settings) : null;
    return {
      shown: settings.shown,
      describe,
      label: (base, description) => {
        const said = describe(description);
        if (!said) return base;
        // Two whole sentences, the label's and the description's, one after
        // the other: a label that ends without a full stop ("Photo 1 / 3",
        // "Photo 1 / 3. Travelling") gets one, so the caption and the
        // machine's words are never run together.
        return /[.!?]$/.test(base) ? `${base} ${said}` : `${base}. ${said}`;
      },
    };
  }, [t, settings]);
}
