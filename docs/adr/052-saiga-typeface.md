# ADR-052: Saiga, Kuutti's typeface, in the app and the panel, its files never public

- Status: proposed (built as written here at the maintainer's word of 2026-10-24, "Saiga IN!", with his choice that day that the panel's copy is uploaded by hand; the token, the Expo GitHub App's reach, the uploads and Spoke's credit are his, the type scale the designer's, see Open)
- Date: 2026-10-24
- Follows: TD-2 (Expo and EAS as the native shell and the update channel), TD-9 (the design tokens, NativeWind), ADR-004 §3 (write access is the trust of what runs with `EXPO_TOKEN`), ADR-025 §3, §4 and §5 (the panel's CSP, its caching and its deploy), ADR-047 (the drawings follow the code), ADR-050 (the panel's components, system fonts only), CLAUDE.md (Decisions: the delivery of a licensed asset is infrastructure; Security: secrets; Accessibility: the OS's font scaling), the website's decision 18 (`kuutti-app-site`); issues #394, #408, #405

## Context

Saiga is Spoke Type's typeface. Spoke licensed it to Kuutti ry by e-mail on 20 and 21/10/2026: "The license allows use only on the Kuutti app and other media relating to the Kuutti brand [kollateral, advertising, social media, website]". The maintainer had offered, in the request Spoke answered, to keep the font files out of the public repositories and to ship them only inside the app's builds and the website. The files are Saiga 1.002, "All rights reserved": Light, Regular, Medium, Bold, Extrabold and Black, each with an italic, as OTF, TTF and WOFF2. They are in the association's private repository `kuutti-app-fonts`, with their SHA-256 sums and the e-mail.

This repository is public. A file once pushed stays reachable: a squash merge leaves a pull request's commits at `refs/pull/<n>/head`, and `main` is never rewritten. A GitHub runner's caches, artifacts and logs are public too: any signed-in user can download an artifact. #394 listed nine ways the files could leak, and designed the fetch. The website went first (its decision 18): Amplify's build fetches four WOFF2 faces at a pinned commit with `FONTS_TOKEN`, falls back to Inter, and a content check keeps fonts out of git.

The app adds three things the website does not have:

- **The fingerprint.** `runtimeVersion` follows it, and GitHub runners compute it without the fonts: `deploy.yml`'s `eas update`, `preview.yml`, `eas-build.yml`'s compare and `e2e.yml`. If a build with Saiga and one without differed, updates would stop reaching the builds. `@expo/fingerprint` hashes the files an `expo-font` plugin entry names, and the entry fails `expo prebuild` when a file is missing.
- **Updates and the web export.** A font loaded at run time (`useFonts` with `require`) rides every EAS Update to Expo's CDN and every web export to EAS Hosting. Both are public, and both are built on GitHub runners. A `require` of a missing file also breaks Metro, Jest and CI's export.
- **The fallback.** React Native 0.86 draws an unknown family in the system font, at the asked weight, on both platforms: iOS in `RCTFontUtils.mm`, Android with `Typeface.create`. A build without Saiga needs no stand-in font.

The panel is built on GitHub runners, its build is an artifact (`admin-dist`, `admin-preview`), and its CSP (`default-src 'none'`) had no `font-src`. #394 left it on `system-ui` for those reasons.

Saiga covers every character of `messages.yaml` (å, ä and ö among them) but ✓ (U+2713). It has no 600, no OpenType features (no `tnum`), and figures of their own widths. Its line box is tall: ascent 1010 and descent 335 per 1000 units, against about 1200 for the system fonts.

## Decision

1. **The files live in `kuutti-app-fonts` alone, at a pinned commit.** `scripts/saiga.json` names the commit and the five faces the app and the panel use (Regular, Italic, Medium, Bold, Extrabold), with the SHA-256 of each one's TTF (native) and WOFF2 (web) file. It also lists the SHA-256 of all 36 delivered files, for the guard. A new release of Saiga is a new manifest, with the version in every path.
2. **Two places fetch them, never a GitHub workflow.** `scripts/fonts.ts` (`pnpm fonts`) has no dependencies. It writes into `~/.cache/kuutti-fonts/saiga-<version>/` and never into the checkout, all files or none, each verified. It runs:
   - on a member's laptop, with the member's own `gh` login;
   - on the EAS builder, as `apps/mobile`'s `eas-build-pre-install` hook, with `FONTS_TOKEN`, an EAS secret in the environments `preview` and `production`. The hook runs before the install; `eas-build-post-install` would run after prebuild, too late.

   It refuses to run under `GITHUB_ACTIONS`, and `check-workflow-permissions.py` refuses a workflow or action that names it, its token, its repository or its cache. Without a credential or without access, it says so and exits 0: the app is in the system font. On EAS (`--soft`) no failure fails the build.
3. **Native, embedded, one fingerprint.** `apps/mobile/plugins/withSaiga.js` is named in `app.json` without options. When every face is in the cache, it applies `expo-font`'s plugin with them: iOS by file (`UIAppFonts`), Android as one XML family `Saiga` with its weights, without which `fontWeight` would be a synthetic bold. When any face is missing, it does nothing.

   No font list is in the config, `_internal` is not hashed, and the same modules load either way, so a build with Saiga and one without have one fingerprint. `plugins/fingerprint.test.js` holds this with two real computations, each with its own `HOME`. Adding the plugin moves the fingerprint once: a native change of its own, after the seal-head icons' (#444), whose builds it orphans, so the next development build follows it.

   Run-time loading was not chosen, for the reasons in Context: the files would ride public updates and exports built on runners, an absent file breaks the toolchain, and an update exported without them would switch installed apps back.
4. **The type.**
   - NativeWind's `font-sans` is Saiga first, then a system stack: a phone takes the first family, the web the whole stack. It is on every text primitive: `Text`, `Input`, `Label`, and the dialog's title and description.
   - `font-semibold` is 700: Saiga has no 600, and each platform would pick its own neighbour. The website draws its 650 in Bold. The designer may say otherwise (#408).
   - The OS's font scaling is unchanged (`MAX_FONT_SCALE`). A character Saiga lacks falls back by the platform's cascade, or by the stack on the web.
5. **The web target** has `@font-face` rules in `global.css`, which native ignores. Metro's dev server answers the files from the cache, to this computer alone (`metro.config.js`). No export carries them, so a pull request's web preview is in the system font.
6. **The panel** names four faces at `/fonts/saiga-<version>/`, root-absolute, so a preview under `/pr-<n>/` finds them too.
   - `--font-sans` is Saiga and a system stack, and semibold is 700. `tabular-nums` keeps the system's font, since Saiga has no tabular figures.
   - The maintainer uploads the WOFF2 faces to each environment's bucket by hand (`pnpm fonts -- --upload <bucket>`, with his AWS login), immutable. The deploy's sync excludes `fonts/*` as it excludes `pr-*`.
   - The CSP gains `font-src 'self'` (ADR-025 §3), and `build.yml` reads it back.
   - Vite's dev server answers the files from the cache, to this computer alone.
   - The maintainer chose this on 2026-10-24, over the panel staying on `system-ui` (#394) and over deploy jobs fetching with a GitHub environment secret.
7. **The guards.**
   - `scripts/check-fonts.ts` reads what git holds, by content: a font's first bytes (an sfnt only with a table directory that fits), an archive, a font in a data URL, a delivered file's SHA-256, or a font's extension. It runs in `pnpm lint`, in `pre-commit` (the index), in `pre-push` (every ref, main and tags too, and every commit the push brings that the remote does not have), and in `secret-scan.yml` (every commit of a push or a pull request, in a run no later push cancels; the whole history weekly).
   - `.gitignore` ignores font extensions.
   - `.claude/settings.json` denies reading font files and the cache.
   - `env:doctor` says whether Saiga is there.
   - A font that got pushed anyway: the maintainer asks GitHub Support to purge it, and decides whether Spoke is told.
8. **The licence is recorded here and in `kuutti-app-fonts`**, not in `scripts/license-policy.json`, which covers code dependencies. The README's licence section says Saiga is not under the repository's licence. A fork builds and runs in the system font: nothing of the program depends on Saiga.

## Consequences

- **Who can reach the token.** `FONTS_TOKEN` reaches everyone who can start an EAS build of any commit: holders of `EXPO_TOKEN`, so everyone with write access (`preview.yml` gives it to every branch, ADR-004 §3), and the Expo organisation's members. Write access goes only to the team the licence covers. The token reads the font repository and nothing else.
- **The files are public the way any web font is.** They are inside every APK and IPA, under the panel's `/fonts/`, and on `kuutti.app`: inside the app's builds and the website, as the licence allows. An internal EAS build from a pull request's branch embeds Saiga too: it is an app build.
- **A prebuild holds copies.** `expo prebuild` with Saiga copies the faces into the gitignored `android/`, and a build into Xcode's and Gradle's outputs, all on the machine that has Saiga already. Metro reads neither native folder (`metro.config.js`), so its `/assets/` cannot hand them out, and the font route answers this computer alone: loopback, a local host name, nothing forwarded.
- **CI never has Saiga.** Pull requests' web previews, the e2e flows and CI's exports are in the system font. A screen must not depend on Saiga's metrics (rules/mobile.md).
- **Taller lines.** Saiga's line box is taller than the system fonts', so the text classes' line heights sit closer to the glyphs. The screens were checked at the largest text size (the pull request's screenshots).
- **The panel, before the upload.** Until the maintainer uploads the faces, the panel asks for them and its host answers `index.html` (ADR-025 §2). The browser drops that, logs a warning, and uses the system font. The panel's flows (ADR-051), which run where Saiga never is, expect exactly those warnings and no other.
- **Cost.** The fetch adds a second to an EAS build. `check:fonts` reads about 1,550 files, in well under a second.

## Open, the maintainer's

1. **The credential:** a fine-grained token, as on the website, a GitHub App or a deploy key (#394: a, b, c). Then `FONTS_TOKEN` in the EAS environments `preview` and `production` (`docs/runbooks/rotation.md`, 13). Until then EAS builds are in the system font.
2. **The Expo GitHub App** is installed on all of the organisation's repositories, with contents and administration write, so it can read `kuutti-app-fonts`. Narrowing it is his setting (#394, step 1).
3. **The uploads:** Saiga to the staging panel's bucket (`pnpm aws:login`, `pnpm fonts`, `pnpm fonts -- --upload <ADMIN_BUCKET>`), and to production's with #25.
4. **Spoke's credit:** whether and how, on the site, in the app's licences screen and in the panel. It waits on Spoke (#405).
5. **The type scale:** SemiBold as Bold, the line heights and the figures are the designer's (#408).
6. **A store build without Saiga** is allowed by `--soft` today. Should a `production` build refuse instead?

## Not done, and what would make it needed

- **No stand-in font,** which #394 proposed. React Native's fallback makes the system font the stand-in, with no font file to license or credit. A stand-in returns if a screen comes to depend on Saiga's metrics.
- **No tag in `kuutti-app-fonts`.** The commit and each file's SHA-256 pin it, as on the website.
- **No Saiga in the e-mails** (#404), which are plain text.
- **No Light, Black or further italics embedded,** since nothing uses them. Adding a face is a line of `saiga.json`.
- **No line for Saiga on the licences screen** until Spoke has answered (#405).

## Alternatives considered

- **Run-time loading,** `useFonts` with `require`: rejected in point 3.
- **The files in this repository, encrypted or in LFS:** both are still in a public repository's objects or its public LFS store.
- **A git submodule, or a `package.json` dependency on the private repository:** either puts the files into every install, every CI job and the cached pnpm store.
- **The panel's fonts fetched by its deploy job** with a GitHub environment secret: automatic, but the token and the files would be on a runner, against points 2 and 7.
- **The panel's fonts read from `kuutti.app`:** needs CORS on the website, and a loosened rule lets any origin use the files.
