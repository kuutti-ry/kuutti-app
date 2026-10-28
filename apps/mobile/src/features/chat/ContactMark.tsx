import type { ContactKind } from "@kuutti/schema";
import Phone from "lucide-react-native/icons/phone";
import { Icon } from "@/components/ui/icon";
import { Ink } from "@/components/ui/ink";

/**
 * The services' own marks, one colour each, tinted with the text (#474).
 * Bundled, never fetched: a request to a service would tell it who uses
 * Kuutti. Sources: assets/glyphs/NOTICE.md.
 */
const MARKS = {
  whatsapp: require("../../../assets/glyphs/contact/whatsapp.svg"),
  telegram: require("../../../assets/glyphs/contact/telegram.svg"),
  instagram: require("../../../assets/glyphs/contact/instagram.svg"),
  snapchat: require("../../../assets/glyphs/contact/snapchat.svg"),
} satisfies Record<Exclude<ContactKind, "phone">, number>;

/**
 * The mark before a contact's kind (#474): the service's, or a phone for a
 * number (lucide's, a placeholder for #410's set). 20 pt at every text size,
 * decorative and hidden from screen readers: the kind's name beside it is
 * the text.
 */
export function ContactMark({ kind }: { kind: ContactKind }) {
  if (kind === "phone") return <Icon as={Phone} size={20} />;
  return <Ink source={MARKS[kind]} className="h-5 w-5 text-foreground" />;
}
