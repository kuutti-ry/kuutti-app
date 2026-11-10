import type { HomeSummary } from "@kuutti/schema";
import { POSTAL_CODE_LENGTH, type PostalMatch, postalMatches } from "@kuutti/schema/postal-areas";
import { useEffect, useState } from "react";
import { Keyboard, View } from "react-native";
import { Choice } from "@/components/Choice";
import { sayAloud, useSpokenOnIos } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { useHapticTap } from "@/theme/haptics";
import { placeName, shownPlaceName } from "./keys";

/** A plain list inside the page's scroll, so a short one: more digits narrow it. */
export const PLACE_ROWS = 8;

type PlaceOffer = {
  rows: readonly PostalMatch[];
  /** `all` lists every match, `more` the first of them, `unknown` the nearest to a code the list lacks. */
  state: "empty" | "all" | "more" | "unknown";
};

/** The first rows of what the digits start, without the code the API refused. */
const matchesOf = (digits: string, rows: number, refused: string | null) =>
  postalMatches(digits, rows + 1)
    .filter((row) => row.code !== refused)
    .slice(0, rows);

/** The areas that share the most of a code the list lacks: the first digits say where it is. */
function nearestAreas(digits: string, refused: string | null): readonly PostalMatch[] {
  const shorter = digits.slice(0, -1);
  const rows = matchesOf(shorter, PLACE_ROWS, refused);
  return rows.length > 0 || shorter === "" ? rows : nearestAreas(shorter, refused);
}

/**
 * What the field offers for what is typed, read on the phone, so that a
 * half-typed home never reaches the server (ADR-061 §4). Digits nothing in the
 * list starts with cannot become a code, so they are said at once, with the
 * nearest areas to choose from. A code the API refused, which a phone's older
 * list can still hold, is no row to tap again (§4).
 */
export function placeOffer(digits: string, refused: string | null = null): PlaceOffer {
  if (digits === "") return { rows: [], state: "empty" };
  const matches = matchesOf(digits, PLACE_ROWS + 1, refused);
  if (matches.length > PLACE_ROWS) return { rows: matches.slice(0, PLACE_ROWS), state: "more" };
  if (matches.length > 0) return { rows: matches, state: "all" };
  return { rows: nearestAreas(digits, refused), state: "unknown" };
}

function offerWords(t: ReturnType<typeof useT>["t"], offer: PlaceOffer): string | null {
  switch (offer.state) {
    case "empty":
      return null;
    case "all":
      return t("profile.place.matches", { areas: offer.rows.length });
    case "more":
      return t("profile.place.more", { areas: offer.rows.length });
    case "unknown":
      return t("errors.postal_code_unknown");
  }
}

/**
 * The postal code, in onboarding and on the home screen (ADR-061 §1): a
 * number field, never focused by itself, since a tap meant for what lies under
 * it would land on the number pad (apps/mobile/e2e/README.md), and the areas
 * that match under it, each a named button whose tap is the answer. The list
 * says the digits one at a time; how many there are is heard, not drawn (#581),
 * and digits the list lacks are said in a line above it. The
 * digits stay in this state: never in the profile's draft, whose refused
 * changes are kept, and never in storage or with Android's autofill service,
 * another company's as often as not (§9). The fifth digit closes the keyboard:
 * nothing is left to type, and the list under the field may lie behind it. A
 * screen that stays after a save takes them away by giving this a new key.
 * `refused` says the API refused the row tapped last; the screen says so itself.
 */
export function PlacePicker({
  busy,
  refused = false,
  onPick,
}: {
  busy: boolean;
  refused?: boolean;
  onPick: (postalCode: string) => void;
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const [digits, setDigits] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const refusedCode = refused ? picked : null;
  const offer = placeOffer(digits, refusedCode);
  const words = refusedCode !== null && offer.state === "unknown" ? null : offerWords(t, offer);
  const unknown = offer.state === "unknown" ? words : null;
  useSpokenOnIos(unknown);
  // The rows show how many match: a screen reader is told as the digits go in (#581).
  const counted = offer.state === "unknown" ? null : words;
  useEffect(() => {
    if (counted !== null) sayAloud(counted);
  }, [counted]);
  const onDigits = (text: string) => {
    const typed = text.replace(/\D/g, "").slice(0, POSTAL_CODE_LENGTH);
    setDigits(typed);
    if (typed.length === POSTAL_CODE_LENGTH) Keyboard.dismiss();
  };
  return (
    <View className="gap-2">
      <Text variant="small">{t("profile.place.code")}</Text>
      <Input
        accessibilityLabel={t("profile.place.code")}
        value={digits}
        maxLength={POSTAL_CODE_LENGTH}
        inputMode="numeric"
        keyboardType="number-pad"
        textContentType="postalCode"
        autoComplete="off"
        autoCorrect={false}
        onChangeText={onDigits}
      />
      {unknown !== null && (
        <Text variant="muted" accessibilityLiveRegion="polite">
          {unknown}
        </Text>
      )}
      {offer.rows.map((row) => {
        const name = placeName(row, locale);
        return (
          <Button
            key={row.code}
            variant="outline"
            className="justify-start gap-3"
            disabled={busy}
            accessibilityLabel={t("profile.place.row", {
              digits: [...row.code].join(" "),
              name,
            })}
            onPress={() => {
              tap();
              setPicked(row.code);
              onPick(row.code);
            }}
          >
            <Text className="font-system text-muted-foreground">{row.code}</Text>
            <Text className="flex-1 font-system">{name}</Text>
          </Button>
        );
      })}
    </View>
  );
}

/**
 * What the person's card says of their home (ADR-061 §3), always in sight, and
 * the heading the screen leads with: the question over the town and the area,
 * the filled one saying it, where an area is kept; where it is not, the line
 * saying what the card shows, in the question's place and role (#581). Some
 * kept areas bear their town's name (Sipoo, Maarianhamina, and Savonlinna in
 * Finnish alone), and two buttons of one name choose nothing. A name stands
 * alone or after a colon: no sentence is built around it (TD-17).
 */
export function PlaceChoice({
  home,
  busy,
  onChoose,
  heading = "h3",
}: {
  home: HomeSummary;
  busy: boolean;
  onChoose: (showArea: boolean) => void;
  /** Its heading's level on the screen that holds it. */
  heading?: "h1" | "h3";
}) {
  const { t, locale } = useT();
  const tap = useHapticTap();
  const town = placeName(home.town, locale);
  const area = home.area && placeName(home.area, locale);
  const choose = (showArea: boolean) => {
    tap();
    if (!busy && showArea !== home.showArea) onChoose(showArea);
  };
  if (!area || area === town) {
    return (
      <Text variant={heading} accessibilityRole="header">
        {t("profile.place.onCard", { place: shownPlaceName(home, locale) })}
      </Text>
    );
  }
  return (
    <View className="gap-4">
      <Text variant={heading} accessibilityRole="header">
        {t("profile.place.choice")}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("profile.place.choice")}
        className="gap-2"
      >
        <Choice label={town} chosen={!home.showArea} onPress={() => choose(false)} />
        <Choice label={area} chosen={home.showArea} onPress={() => choose(true)} />
      </View>
    </View>
  );
}
