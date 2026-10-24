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

## Saiga, 2026-10-24 (ADR-052, #394, #408)

`saiga-2026-10-24/`: Saiga, Kuutti's typeface, in the panel, the app's web target and the iOS app, with the files fetched by `pnpm fonts` into this computer's cache and nowhere in the project. Pictures of the type, never its files.

- The panel (`panel-*`): its production build, served as the bucket and the distribution serve it: the build at the root, Saiga under `/fonts/saiga-1.002/`, a missing path answered by `index.html`, and ADR-025 §3's CSP with `font-src 'self'`. Signed in through the mock bank as Mikael, a moderator, against the shared local database: the overview in light (`01`), its table, whose figures keep the system's font, since Saiga has no tabular figures (`02`), and in dark (`03`), at 1000 by 550 (drawn at 800 by 440). The sign-in at 320 by 640 in light and dark (`04`, `05`), in a browser that had no session. Under the CSP without `font-src` the same build drew in the system font and the console named each refused face; with it the faces loaded and the console stayed empty.
- The web target (`web-*`): Metro's dev server on this computer, which answers Saiga to it alone (a request from the network address got 404). The sign-in at 1000 by 550 in light and dark (`01`, `02`), and at 320 by 640 in Finnish, light (`03`), and in Swedish, dark (`04`), with å, ä and ö. A pull request's web preview has no Saiga and is in the system font.
- iOS (`ios-*`): a dev client built from this change on its own simulator (iPhone 18 Pro, iOS 27), Saiga embedded by `plugins/withSaiga.js`; the dev client's menu showed the runtime version `d4d121c0…`, the fingerprint the same commit had without Saiga (built before the branch moved onto main's 0.67.0, where the pair is `6d3e1968…` for iOS and `33a12793…` for Android, again with and without). Before signing in, in English, light and dark (`01`, `02`); at the largest accessibility text size (`content_size accessibility-extra-extra-extra-large`, the 2x cap), in Swedish, light (`03`), and in Finnish, dark (`04`, and its button, `05`): the heading's Extrabold and the subheading's Bold, Å's ring and Ä's and Ö's dots whole, nothing clipped. The grey and blue gear is the dev client's own tools button.
- Android was not run: its prebuild was read instead, which holds the five faces in `res/font/`, the family `xml_saiga.xml` with their weights and styles, and `MainApplication`'s `ReactFontManager.addCustomFont(this, "Saiga", …)`.
