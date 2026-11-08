import { CONTACT_KINDS, type ConversationContacts } from "@kuutti/schema";
import { act, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type React from "react";
import { a11yProblems, type HostNode, hiddenNodes, markBefore, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { ContactMark } from "./ContactMark";
import { ContactShare } from "./ContactShare";
import { SharedContacts } from "./SharedContacts";

// The services' marks beside a contact (#474): one for every kind, decorative
// and hidden from screen readers, and on the line under the header and the
// share dialog's rows without changing a word a screen reader hears. The
// Ways to reach you screen's cards are checked in YourContacts.test.tsx.

const tree = () => screen.toJSON() as HostNode | HostNode[] | null;
const marked = (words: string) => markBefore(tree(), words);

const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  });

const VALUES = {
  phone: "+358401234567",
  whatsapp: "+358401234567",
  telegram: "ville_k",
  instagram: "ville.k",
  snapchat: "ville.snaps",
} as const;
const PIECES = CONTACT_KINDS.map((kind) => ({ kind, value: VALUES[kind] }));
const LINES = [
  "Phone: +358401234567",
  "WhatsApp: +358401234567",
  "Telegram: ville_k",
  "Instagram: ville.k",
  "Snapchat: ville.snaps",
];

const dialog = (mine: ConversationContacts["mine"]) => (
  <ContactShare
    conversationId="c"
    contacts={{ mine, theirs: [] }}
    closed={false}
    name="Ville"
    open
    onClose={() => undefined}
    onDetail={() => undefined}
    onStale={() => undefined}
  />
);

beforeEach(() => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
});

describe("the services' marks (#474)", () => {
  it.each(CONTACT_KINDS)("draws one for %s, hidden from screen readers", async (kind) => {
    await show(<ContactMark kind={kind} />);
    expect(tree()).not.toBeNull();
    expect(hiddenNodes(tree()).length).toBe(1);
    expect(screen.queryByRole("image")).toBeNull();
  });

  it("goes before each line under the header, and the line is heard as before", async () => {
    await show(<SharedContacts name="Ville" theirs={PIECES} />);
    expect(hiddenNodes(tree()).length).toBe(CONTACT_KINDS.length);
    expect(LINES.map(marked)).toEqual(LINES.map(() => true));
    expect(LINES.map((line) => screen.getByText(line).props.accessibilityLabel)).toEqual([
      "Ville shares a phone number: +358401234567",
      "Ville shares WhatsApp: +358401234567",
      "Ville shares Telegram: ville_k",
      "Ville shares Instagram: ville.k",
      "Ville shares Snapchat: ville.snaps",
    ]);
  });

  it("goes before each row of the share dialog, whose buttons keep their names", async () => {
    await show(dialog(PIECES.map((piece) => ({ ...piece, shared: piece.kind === "snapchat" }))));
    expect(LINES.map(marked)).toEqual(LINES.map(() => true));
    for (const name of [
      "Share your phone number",
      "Share your WhatsApp",
      "Share your Telegram",
      "Share your Instagram",
      "Stop sharing your Snapchat",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(pressables(tree() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
  });
});
