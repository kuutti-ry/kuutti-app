---
paths:
  - "apps/mobile/**"
---

# Mobile (Expo) rules

Stack: Expo SDK 57, React Native 0.86, React 19, TypeScript, dev client (`expo start --dev-client`, never Expo Go), web target for PR previews only. UI: React Native Reusables on NativeWind v4. Use the Expo plugin's skills and MCP for SDK specifics, and check the installed SDK version before following any doc.

## Auth and network

- Backend-driven auth: open the system browser at `api/auth/start`, receive a one-time code by deep link, exchange it for a session. The app never holds a client secret, an ID token, or Telia's PKCE state; it does hold its own verifier for each sign-in attempt, with the pending mark in `expo-secure-store`, whose SHA-256 `/auth/start` carries and `/auth/exchange` checks (RFC 8252 §8.1, ADR-027).
- Session and refresh tokens live in `expo-secure-store`, never AsyncStorage.
- API base URL comes from `Constants.expoConfig.hostUri` in dev and `EXPO_PUBLIC_API_URL` otherwise. `EXPO_PUBLIC_*` is public by definition; never put a secret there.
- No analytics or tracking SDK in the app. Research events are emitted server-side only.
- App Links and Universal Links files (`assetlinks.json`, `apple-app-site-association`) are served by the API, not bundled here.

## Images

- Upload only through the API. Pre-resize to 1600 px with `expo-image-manipulator` (which drops EXIF) before upload.
- Render with `expo-image`; `cacheKey` is `photoId/variant`, never the signed URL. Use the blurhash from the profile JSON as the placeholder.
- Variants: thumb in lists, card on open, full only on zoom. Never prefetch beyond the current round; prefetch counts as exposure.
- Screenshots are never blocked (the maintainer's decision of 15/10/2026, #296): blind and partially sighted people describe a photo from a screenshot with Be My AI or Seeing AI, and TD-6's premise is that single-user capture cannot be prevented; the controls are the exposure budget and the fetch log (#52, ADR-008). Whether iOS notices a screenshot is #86's open question.

## UI

- Tokens are CSS variables in `apps/mobile/src/theme/tokens.css`: four sets (light, dark, and the high-contrast pair) defined together, mapped to Tailwind names in `tailwind.config.js`; `userInterfaceStyle: automatic`. Never hardcode a colour: a component uses token classes (`bg-primary`, `text-muted-foreground`) only. A new token goes into all four sets and, if text sits on it, into the pair list of `src/theme/contrast.ts`; `pnpm --filter mobile check:contrast` holds text to 4.5:1 (7:1 in high contrast) and control outlines to 3:1, in CI.
- Screens are built from the primitives in `src/components/ui/` (React Native Reusables, adapted; add one with `npx @react-native-reusables/cli add <name>` and then bring it to the baseline below). Wrap the app in `ThemeProvider`; test with `renderWithTheme` from `src/test/render.tsx`.
- The accessibility rules in `CLAUDE.md` apply to every component. Add `accessibilityLabel` and `accessibilityRole` in the same change that adds the touchable. The required-label convention: a primitive whose content is not plain text (`Button` with an icon child, `Input`, `Switch`, `DialogContent`'s `closeLabel`) takes its label as a required prop, so a missing label is a type error, and the string comes from i18n. Icons are decorative and hidden from screen readers.
- Sizes are minimums, never fixed heights (`min-h-touch`, 44 pt, `TOUCH_TARGET` in `src/theme/a11y.ts`); a control drawn smaller extends its target with `hitSlopFor`. Text scales with the OS up to `MAX_FONT_SCALE`. `src/test/a11y.ts` (`pressables`, `a11yProblems`) checks role, label and target of everything pressable; run it over every new screen's tree.
- Every animation and haptic is gated by `useReducedMotion` / `useMotionDuration` / `useHapticTap` from `src/theme/`.
- Icons: one import per icon (`lucide-react-native/icons/<name>`), never the package root, which pulls the whole set into the bundle.
- Decisions are buttons with configurable placement (order, left or right thumb, one-handed). No swipe as primary input, no rapid repeat.
- Every candidate card shows its reason label: matches all filters, liked you, sent you a fish (#378), seen before, or included because you relaxed X.
- Candidate lists are bounded to the round. No pagination, no "load more", no on-demand fetch of the next profile.
- Glyph sets never imitate console vendors' trademarked shapes or names.
- Text is Saiga (ADR-052) through `font-sans`, which `Text`, `Input`, `Label` and the dialog's title and description carry; a new text primitive carries it too. Saiga has no 600: `font-semibold` is Bold (`tailwind.config.js`), and no tabular figures. A build without Saiga, and every web preview, is in the system font: a screen never depends on Saiga's metrics.
- The Android theme declares `android:forceDarkAllowed=false` (`plugins/withNoForceDark.js`, #27): the app follows the system scheme and ships its own dark and high-contrast sets, so a launcher's forced dark mode (MIUI) must not repaint them.

## Notifications

- One push per day at round time (`round_push_hour`, to those who have not opened the day's round). Two exceptions, the maintainer's of 25/10/2026: a message, to somebody not in the app, at most once a conversation per `message_push_min_interval_minutes`; and a new match, to the person whose earlier like it met. Nothing in the quiet hours. A push says that there is something, never what or from whom: no message text, no name, no account id, no badge (ADR-055).
- The permission is asked once there is something to tell (the home screen's offer, once matching is open), with the reason, never at the first start; an answer is remembered and the offer never comes back. Everything works without it.

## i18n

- Every user-facing string is a typed `t()` key from `packages/i18n`, through `useT()` from `src/lib/locale.tsx`. No inline strings (`pnpm lint` fails on them), no concatenation with inflected values; `in {pond}` is banned. Required label props (`accessibilityLabel`, `closeLabel`) take `t(...)` too.
- The language is the stored in-app choice if there is one, else the phone's first language with a catalogue (`expo-localization`), else English; `LocaleProvider` wraps the app above `ThemeProvider`. Tests render through `renderWithTheme`, which supplies both, and set the phone's language with the `expo-localization` mock (`src/lib/locale.test.tsx`).
- ICU plurals; Intl for dates and numbers; the `en-XA` pseudo-locale in dev builds to catch overflow.

## Testing and builds

- Component tests use jest-expo, not Vitest. Test that accessibility props exist.
- A change to a screen is walked with VoiceOver and TalkBack before it is pushed (#217): no unlabelled control, no path that only a gesture opens, and the pull request says which screens were walked, on which phones, by whom. A screen or step added or removed adds or removes its row in `docs/accessibility-checklist.md`, the chart of the pass before each release. An agent cannot run a screen reader, and a jest check, a screenshot or a read of the code is no walk: it pushes the screen unwalked, its pull request says so and why, and its commit message carries a line `Unwalked: <screens>`, which the squash keeps on `main`. Such a pull request merges when green like any other (the maintainer, 17/10/2026); the release pass walks those screens first (`git log <last tag>..origin/main --grep '^Unwalked:'`). A walk not done is never claimed.
- EAS Update uses `runtimeVersion: { policy: "fingerprint" }`; rebuild natively only when the fingerprint changes. Channels `staging` and `production` follow the deploy promotion. Any change to `app.json` moves the fingerprint of both platforms and orphans every installed build; batch native changes. `app.config.ts` stamps the git commit into `extra.commit`, and `fingerprint.config.js` skips `extra` so that a commit is never a native change.
- The web preview runs only against the mock IdP and seed data. Nothing in the web target may become a product web surface.
