# Design evidence

Dated checks of the design tokens (`apps/mobile/src/theme/tokens.css`, TD-9; the moderation panel's `apps/admin/src/tokens.css`, ADR-050). Contrast is checked on every change by `pnpm --filter mobile check:contrast`; what is here was done once by hand and is repeated when the palette changes.

## Deuteranopia, 2026-09-19 (#12)

`palette-deuteranopia-2026-09-19.png`: every token of the four sets as defined (left of each pair) and under simulated deuteranopia (right; Machado, Oliveira and Fernandes 2009, severity 1.0, applied in linear RGB).

- Every text pair of `src/theme/contrast.ts` still meets its threshold on the simulated colours, in all four sets. Tightest: `--destructive` on `--card` in light, 5.13:1 (4.5 required); `--muted-foreground` on `--muted` in dark, 6.86:1.
- `--primary` and `--destructive` keep different hues (blue against olive) but land at almost the same lightness: 1.0:1 to 1.4:1 between them in every set. They can be told apart side by side, not reliably on their own. That is the accessibility rule in practice: a destructive action is never marked by colour alone, it differs in label, shape and position, and pass and like are never a red and green pair.
- Nothing in the palette relies on a red and green distinction.

## UI foundation on the iOS simulator, 2026-09-19 (#12)

`ui-foundation-2026-09-19/`: the smoke screen on iPhone 18 Pro (iOS 27), built from the primitives and tokens. `ios-light.png` and `ios-dark.png` follow the system appearance; `ios-high-contrast-light.png` and `ios-high-contrast-dark.png` were switched by the OS setting Increase Contrast (`xcrun simctl ui <udid> increase_contrast enabled`), not by the in-app toggle, so they also show the app following the system; `ios-largest-font.png` is the largest accessibility text size (`content_size accessibility-extra-extra-extra-large`): text grows to the 2x cap and nothing is clipped. The grey round button at the top right is the dev client's own tools button, not part of the app.

## Languages on the iOS simulator, 2026-09-19 (#13)

`i18n-2026-09-19/`: the smoke screen on iPhone 18 Pro (iOS 27). `ios-en.png` on an English phone; `ios-fi-device.png` after switching the phone's language to Finnish (`AppleLanguages` to `fi-FI`), with nothing chosen in the app: the app follows the device. `ios-en-XA.png` and `ios-en-XA-largest-font.png` are the pseudo-locale of a dev build, at the normal and at the largest accessibility text size: text is about a third longer, bracketed at both ends (a missing bracket would mean a clipped or concatenated string), and it wraps without clipping. The in-app override could not be tapped on the simulator from the agent session (the simulator control tool needs `sudo xcode-select`), so the pseudo-locale shots start the app in `en-XA` by a local, reverted edit; the override itself is proven by `language.test.tsx` and was exercised on the dev web target.

## The moderation panel on shadcn/ui, 2026-10-24 (#302, ADR-050)

`admin-ui-2026-10-24/`: the panel's production build, served on a laptop with the content security policy of ADR-025 §3 (the local API as the API's origin, and the local S3 stand-in in `img-src` for its photo URLs), signed in through the mock bank as a member of staff with the admin role, in a private copy of the local database with a few reports, feedback, an automatic shadow ban and a warning added; the browser's console stayed empty throughout. `01` to `14` at 1000 by 550 CSS pixels (the maintainer's window), drawn at 800 by 440; `15` to `21` at 320 by 640. Light and dark follow the system (`prefers-color-scheme`, emulated by the browser). The high-contrast pair (`prefers-contrast: more`) could not be emulated there and is held by `apps/admin/src/tokens.test.ts`.

- Light, wide: the overview (`01`), the report queue (`02`), a report's frozen conversation (`03`), the suspension's confirm step (`04`), the photo queue with the decision beside the photo (`05`), a person's page (`06`), a tunable opened (`07`), the audit log (`08`), the staff list (`09`) and the sign-in (`10`).
- Dark, wide: the overview (`11`), a person's sanctions (`12`), the second look's confirm step, the focus on its first field (`13`), the photo queue (`14`).
- Phone: the overview (`15`), the report queue (`16`), a report's decision, the ban apart (`17`), the warning's confirm step (`18`), a person's page in dark (`19`), the audit log in dark with the menu scrolled to the current screen (`20`) and its table scrolling within its card (`21`).
