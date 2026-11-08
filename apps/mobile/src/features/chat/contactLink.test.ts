import { CONTACT_KINDS, type ContactKind, normaliseContact } from "@kuutti/schema";
import fc from "fast-check";
import { contactLink } from "./contactLink";

// Where a shared contact opens (#473, ADR-031 §11): an address only for a value
// in the one form of its kind, and always on its kind's own host and path, so
// nothing another person typed can send the reader anywhere else.

/** What each kind's address must be, read back from the URL itself. */
const ADDRESS: Record<
  ContactKind,
  (value: string) => { protocol: string; host: string; pathname: string }
> = {
  phone: (value) => ({ protocol: "tel:", host: "", pathname: value }),
  whatsapp: (value) => ({ protocol: "https:", host: "wa.me", pathname: `/${value.slice(1)}` }),
  telegram: (value) => ({ protocol: "https:", host: "t.me", pathname: `/${value}` }),
  instagram: (value) => ({
    protocol: "https:",
    host: "www.instagram.com",
    pathname: `/${value}/`,
  }),
  snapchat: (value) => ({
    protocol: "https:",
    host: "www.snapchat.com",
    pathname: `/add/${value}`,
  }),
};

const NUMBER = /^\+[1-9]\d{6,14}$/;
/** Strings shaped like each kind's values; the properties keep only what normaliseContact does. */
const SHAPED: Record<ContactKind, fc.Arbitrary<string>> = {
  phone: fc.stringMatching(NUMBER),
  whatsapp: fc.stringMatching(NUMBER),
  telegram: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{4,31}$/),
  instagram: fc.stringMatching(/^[a-z0-9._]{1,30}$/),
  snapchat: fc.stringMatching(/^[a-z][a-z0-9._-]{1,13}[a-z0-9]$/),
};

describe("contactLink", () => {
  it.each([
    ["phone", "+358401234567", "tel:+358401234567"],
    ["whatsapp", "+358401234567", "https://wa.me/358401234567"],
    ["telegram", "Ville_K", "https://t.me/Ville_K"],
    ["instagram", "ville.k", "https://www.instagram.com/ville.k/"],
    ["snapchat", "ville-k", "https://www.snapchat.com/add/ville-k"],
  ] as const)("opens a %s at its own address", (kind, value, address) => {
    expect(contactLink(kind, value)).toBe(address);
  });

  it.each([
    ["phone", "040 123 4567"],
    ["phone", "0401234567"],
    ["phone", "+3580401234567"],
    ["phone", "tel:+358401234567"],
    ["phone", "+358401234567;ext=1"],
    ["whatsapp", "+358401234567/evil"],
    ["whatsapp", ""],
    ["telegram", "@ville_k"],
    ["telegram", "vill"],
    ["telegram", "ville_k/../evil"],
    ["telegram", "ville_k?start=1"],
    ["instagram", "Ville.K"],
    ["instagram", "ville.k/"],
    ["instagram", "ville..k"],
    ["instagram", "ville.k#x"],
    ["instagram", "evil.example:80@ville"],
    ["snapchat", "ville-"],
    ["snapchat", "https://evil.example/"],
  ] as const)("builds nothing from a %s that is not in its one form, %p", (kind, value) => {
    expect(contactLink(kind, value)).toBeNull();
  });

  it("puts every value in its one form on its kind's own host and path, and nothing more", () => {
    const anyValue = fc.constantFrom(...CONTACT_KINDS).chain((kind) =>
      SHAPED[kind]
        .filter((value) => normaliseContact(kind, value) === value)
        .map((value) => ({
          kind,
          value,
        })),
    );
    fc.assert(
      fc.property(anyValue, ({ kind, value }) => {
        const url = new URL(contactLink(kind, value) as string);
        expect({ protocol: url.protocol, host: url.host, pathname: url.pathname }).toEqual(
          ADDRESS[kind](value),
        );
        expect([url.username, url.password, url.search, url.hash]).toEqual(["", "", "", ""]);
      }),
      { seed: 473, numRuns: 500 },
    );
  });

  it("builds nothing from any value its kind would change or refuse", () => {
    const hostile = fc.oneof(
      fc.string({ unit: "binary", maxLength: 80 }),
      fc.webUrl(),
      fc.emailAddress(),
      fc
        .tuple(fc.constantFrom(...CONTACT_KINDS), fc.constantFrom("@", " ", "/", "?", "#", ":"))
        .chain(([kind, mark]) =>
          fc.oneof(
            SHAPED[kind].map((value) => `${mark}${value}`),
            SHAPED[kind].map((value) => `${value}${mark}x`),
          ),
        ),
    );
    fc.assert(
      fc.property(fc.constantFrom(...CONTACT_KINDS), hostile, (kind, value) => {
        fc.pre(normaliseContact(kind, value) !== value);
        expect(contactLink(kind, value)).toBeNull();
      }),
      { seed: 473, numRuns: 500 },
    );
  });
});
