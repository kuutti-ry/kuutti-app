# End-to-end flows (Maestro)

Flows that drive the app on a simulator against the local environment: the real API on Postgres, the mock bank, the S3 stand-in (#164, ADR-020). They are YAML read by [Maestro](https://maestro.mobile.dev), the same files for iOS and Android.

## Run

1. Once: `brew trust mobile-dev-inc/tap && brew install --formula mobile-dev-inc/tap/maestro` (the tap is Maestro's own; `--formula`, since the cask is the desktop app). It brings OpenJDK keg-only, which `pnpm e2e` puts on the PATH; to call `maestro` yourself, `export PATH="$(brew --prefix openjdk)/bin:$PATH"` first.
2. `pnpm env:up` in one terminal: the database, the API on 3000, Metro on 8081.
3. A booted simulator with the dev client installed (`pnpm dev:mobile` has built it before). With two booted, name one: `maestro --device <udid> test apps/mobile/e2e/flows`.
4. `pnpm e2e` runs every flow under `flows/`; `maestro test apps/mobile/e2e/flows/language.yaml` runs one. `maestro studio` inspects what a screen shows to Maestro, the way to find a text that does not match.

## How a flow is written

- `common/` holds the steps flows share; `flows/` holds one file per behaviour, named for it. `flows/` is what `pnpm e2e` runs.
- A flow starts with `runFlow: ../common/sign-in.yaml`, which signs out if needed and signs in at the mock bank as `PERSONA` (the persona's given and family name as the mock bank's page shows them; `Sanna Korhonen` unless the flow says otherwise). The cast and their stories: `packages/db/src/seed/personas.ts`, `histories.ts`; `pnpm demo:reset` puts them back.
- Texts are matched as Maestro's regular expressions, and the app speaks three languages, so a tap or an assertion names the text in all three (`"Settings|Asetukset|Inställningar"`), taken from `packages/i18n/messages.yaml`. A decorative image (a glyph, the mark) is hidden from Maestro as from a screen reader: assert the text beside it.
- Screens are reached by deep link (`openLink: kuutti://settings`, `kuutti://profile/later/politics`), the way the handoff's manual checks did.
- A flow leaves the app as it found it where it can (the language flow ends on the phone's language), so the next one starts clean.

## Not here yet

The admin panel (Playwright), Android in CI, a dev-only sign-in link should the system browser prove flaky under Maestro, and the flows of the storyboard's scenes. ADR-020 lists them.
