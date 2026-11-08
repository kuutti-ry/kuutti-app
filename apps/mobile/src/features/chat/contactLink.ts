import { type ContactKind, normaliseContact } from "@kuutti/schema";

/**
 * Where a shared contact opens (#473, ADR-031 §11), built here from its kind
 * and its value and nowhere else, so nothing a message, a profile or a server
 * answer says ever becomes an address. Only a value in the one form of its
 * kind gets one: those rules allow no `/ ? # : @`, so no value can name
 * another host or path. Null leaves the text alone. https, not the services'
 * own schemes: their apps claim these links where installed, the browser shows
 * the service's page where not, and nothing native changes.
 */
export function contactLink(kind: ContactKind, value: string): string | null {
  if (normaliseContact(kind, value) !== value) return null;
  switch (kind) {
    case "phone":
      return `tel:${value}`;
    case "whatsapp":
      // wa.me takes the digits, without the +.
      return `https://wa.me/${value.slice(1)}`;
    case "telegram":
      return `https://t.me/${value}`;
    case "instagram":
      return `https://www.instagram.com/${value}/`;
    case "snapchat":
      return `https://www.snapchat.com/add/${value}`;
  }
}
