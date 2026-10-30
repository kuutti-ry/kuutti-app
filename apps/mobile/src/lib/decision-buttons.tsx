import * as React from "react";
import { readPreference, writePreference } from "./preferences";

/**
 * Where the round's decision buttons sit (#82): for the right hand or the
 * left, and in one-handed mode a column on that side with Undo brought down
 * from the header, all within a thumb's reach. Kept on the phone with the
 * theme and the language, never sent to the API: it is about the hand and
 * the phone, and how a person holds their phone is nobody's business. Pass
 * and Like keep their own shape, word and icon wherever they sit (CLAUDE.md
 * Accessibility); Block or report stays on the card, far from them
 * (ADR-030 §11). `style` is which marks Pass and Like carry (#520): Kuutti's
 * own icons, a controller's ✕ and ○, or its A and B. Their shape and word
 * stay, and the choice stays here for the same reason: which console a person
 * plays on is nobody's business either.
 */
export type Hand = "right" | "left";
export type ButtonStyle = "kuutti" | "shapes" | "letters";
export type DecisionButtons = { hand: Hand; oneHanded: boolean; style: ButtonStyle };

export const DEFAULT_DECISION_BUTTONS: Readonly<DecisionButtons> = {
  hand: "right",
  oneHanded: false,
  style: "kuutti",
};

/** What was stored; anything unknown is the default, field by field, and so is a store that holds nothing. */
export function readDecisionButtons(raw: string | null): DecisionButtons {
  const settings = { ...DEFAULT_DECISION_BUTTONS };
  if (raw === null) return settings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return settings;
  const { hand, oneHanded, style } = parsed as Record<string, unknown>;
  if (hand === "right" || hand === "left") settings.hand = hand;
  if (typeof oneHanded === "boolean") settings.oneHanded = oneHanded;
  if (style === "kuutti" || style === "shapes" || style === "letters") settings.style = style;
  return settings;
}

type Settings = {
  settings: DecisionButtons;
  /** Changes what is given and keeps the rest; written to the phone at once. */
  set: (change: Partial<DecisionButtons>) => void;
};

const DecisionButtonsContext = React.createContext<Settings | null>(null);

/** Reads the stored choice once and hands it to the round screen and to the setting's screen. */
export function DecisionButtonsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<DecisionButtons>({
    ...DEFAULT_DECISION_BUTTONS,
  });
  React.useEffect(() => {
    let mounted = true;
    void readPreference("decisionButtons").then((stored) => {
      if (mounted) setSettings(readDecisionButtons(stored));
    });
    return () => {
      mounted = false;
    };
  }, []);
  const set = React.useCallback((change: Partial<DecisionButtons>) => {
    setSettings((previous) => {
      const next = { ...previous, ...change };
      void writePreference("decisionButtons", JSON.stringify(next));
      return next;
    });
  }, []);
  const value = React.useMemo<Settings>(() => ({ settings, set }), [settings, set]);
  return (
    <DecisionButtonsContext.Provider value={value}>{children}</DecisionButtonsContext.Provider>
  );
}

export function useDecisionButtons(): Settings {
  const context = React.useContext(DecisionButtonsContext);
  if (!context) throw new Error("useDecisionButtons needs a DecisionButtonsProvider");
  return context;
}
