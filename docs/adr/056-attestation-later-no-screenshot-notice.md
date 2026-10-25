# ADR-056: The rest of TD-6: attestation later, no screenshot notice, no full size of others

- Status: accepted 2026-10-25 (#86, the maintainer's decisions of that day, built as written here; when one of §1's triggers comes, starting §2 is his)
- Date: 2026-10-25
- Follows: TD-1 (every account is one bank-verified person), TD-6 (exposure is counted and budgeted; a verified person can capture what they are shown), ADR-004 (EAS updates are not code-signed; §4, signing returns before builds reach people outside the team), ADR-008 (the budget, the shown record and the fetch log; §3 amended here), ADR-027 (the sign-in bound to the device, and what it does not close), ADR-030 §4 and ADR-031 §4 and §5 (a report blocks and hides the conversation; the export holds the other person's lines as a time and a length), ADR-033 (an automatic rule changes no answer), ADR-041 (velocity; its Open 1 and 2 are settled here), #296 (screenshots are never blocked), CLAUDE.md's Decisions (these two items were the maintainer's to settle) and Product constraints; issues #86, #184

## Context

After the velocity rules (ADR-041), #86 held what was left of TD-6's list against harvesting: app attestation, and whether iOS notices a screenshot. `FLAG_SECURE` had gone on 15/10/2026 (#296). The research of 25/10/2026 was six passes and two adversarial fact-checks against the vendors' documents and source; #86's body lists its findings and sources. It established these facts.

**What a script gets that the app does not.** A bank-verified person with their own session sees the same people through the API as through the app:
- at most their round (`round_size` 10 and `liked_you_cap` 10);
- another person's photo only from a card the server built for them (ADR-008 §3);
- the day's budget for each size.

Three things differed, all within the day's budget and ADR-041's pace:
- **Another account's full size.** The app asks for the full size only of one's own photos (`PhotoZoomScreen`) and of a photo sent in a conversation (through the chat's own routes). Yet `GET /photos/{id}/full` served another account's photo from a shown card, up to 60 a day. ADR-041 had left it out as a rule, calling it "a candidate if attestation is long in coming".
- **The card size of a card's other photos.** The card builder records every approved photo of the person as shown (`recordCardServed` in `profile/card.ts`), while the app asks for the card size of the main photo only and a thumb of each other one (`ProfileCardView`). With `max_photos` at 6, a round's 20 cards hold up to 120 card-size photos where the app takes 20, under the card budget of 300 a day.
- **People shown on earlier days.** Nothing deletes an old `card_shown` row: the sweep is held (ADR-008 History, 2026-10-19). A script can fetch the card size of anyone it was ever shown for as long as they stay active, and the answer turns 404 when they pause, are sanctioned or block. That is a standing "still here" signal the app never asks for, since it shows only today's round.

**How a token is read.**
- The app pins no certificate.
- iOS trusts a root certificate that its owner installs and switches on, so an iPhone owner can read their own access and refresh tokens through a proxy.
- Android 7 and later trusts no user certificate by default, so it takes root or a re-signed APK.
- No phone is needed at all. A script can open the sign-in itself, let the person finish the bank login in a desktop browser, and exchange the code with its own verifier (ADR-027, "What it does not close").

**Apple App Attest.**
- Expo's module is `@expo/app-integrity`: MIT, with 57.0.2 under the `sdk-57` tag, and its v57 docs still say alpha. SDK 57's bundled modules leave it out, so a plain install takes 58.x, which was built against another ABI.
- It is not available on the Simulator, nor on a Mac before macOS 27.
- An attestation is verified in eleven steps and an assertion in eight. `node:crypto` does both without a new dependency. Both Node libraries skip the certificate dates, iOS 27's extensions and the receipts.
- Apple does not document which environment an ad hoc build gets.
- An attestation is anonymous, and assertions never reach Apple.

**Google Play Integrity.**
- Expo's module makes standard requests only. Their tokens are decoded only on Google's servers, as a service account of the Cloud project the app named.
- The defaults are 10,000 decodes and 10,000 preparations a day, raised only for an app on Google Play.
- Before Kuutti is on Play the app's own verdict cannot pass (`PLAY_RECOGNIZED`, `LICENSED`). This is M6; there is no Play Console account yet. On Android 13 and later, no optional signal comes back to an install that did not come from Play.
- The team's EAS internal APKs are unrecognised. CI's `google_apis` emulator has no Play Store and gets no token.
- GrapheneOS, /e/OS, LineageOS and Huawei phones get no token, or at best a basic label.
- Google receives the attestation material, the app's metadata, the licence status and the request hash in cleartext, as an independent controller.
- Hardware key attestation works without Play, but Expo's module cannot sign a later request with the attested key.

**What attestation does not touch.**
- UI automation of the genuine app on a genuine phone, real-device farms and screenshots all pass it truthfully. What limits a harvest is the number of bank identities, and attestation does not touch that.
- Attesting only at sign-in leaves a lifted 90-day refresh token usable from a script.
- While updates are unsigned (ADR-004 §1), the genuine iOS binary may run JavaScript that its owner serves it through a trusted proxy, and App Attest would vouch for it. This is inferred from the update protocol, not tested: signing is optional, the assets are checked against the manifest's hashes, and without signing the manifest is trusted on its transport alone.

**Screenshots.**
- iOS notices a screenshot only after it is taken, and gets no image (`userDidTakeScreenshotNotification`).
- `expo-screen-capture` 57.0.4 registers Android 14's screenshot callback when the module is created. Linking it, even for an iOS-only notice, would make Android announce "Kuutti detected this screenshot" on every screenshot. It also ships the prevention calls that `.claude/rules/mobile.md` forbids.
- A notice misses every automated scraper: scripts, modified clients, a recording, a second camera. It sees only a person harvesting by hand inside the app, whom the budget and ADR-041 already bound.
- It falls instead on people who have reasons:
  - blind users: Be My AI's way in is a screenshot, and Apple's on-device descriptions have no Finnish;
  - people showing a match to a friend before a date, since Kuutti has no share link (rule 8);
  - people keeping evidence. A report blocks and hides the conversation, and the export holds the other person's lines only as a time and a length (ADR-030 §4; ADR-031 §4 and §5).
- An event sent to the server is "gaining of access" under ePrivacy Art. 5(3) as the EDPB reads it (Guidelines 2/2023 ¶53), so it needs consent, which a harvester would refuse. A notice kept on the phone is not (¶44).

On 25/10/2026 the maintainer decided: attestation not now, in a defined shape later; screenshots not noticed; another account's full size refused.

## Decision

1. **No app attestation now.** No `@expo/app-integrity`, no App Attest entitlement, no Google Cloud project for Play Integrity, and nothing at the exchange or the refresh. It comes back when one of these holds:
   1. update signing returns (ADR-004 §4); until then App Attest may vouch for JavaScript that is not ours;
   2. Kuutti is distributed through Google Play, or a small Android module of our own is accepted that signs with the key-attested Keystore key; until then Android has nothing to bind a session to;
   3. a route serves cards outside the round (ADR-041 §1, `cards_served`), or the logs show clients that are not the app.
2. **The shape it takes then**, written as its own ADR:
   - **At the exchange.** The exchange carries an attestation. On iOS that is App Attest over a challenge of the server's (the one-time code may serve). On Android it is a key-attested key, or Play Integrity once Kuutti is on Play. The attestation is verified before the code is spent, and the session row records the key and whether the session was attested.
   - **At every refresh.** Every refresh carries an assertion or a signature over a challenge that the previous refresh returned, and the counter is updated in one conditional statement.
   - **Refusal.** Only on iOS in production, with Mac availability switched off in App Store Connect. Everywhere else an unattested session is marked, for ADR-041's rules to count more strictly, which keeps ADR-033's rule that no answer changes.
   - **Exemptions.** Development, test and previews are exempt by environment, never on the client's word. The demo tools, the panel's flows and the load smoke sign in unattested there.
   - **Play Integrity, if used:**
     - standard requests, at the refresh only;
     - a request hash that is a SHA-256 over the request and a server nonce, never an account id;
     - app-access risk never acted on, since it would flag assistive apps;
     - Google named in the privacy notice.
3. **Another account's photo is never served in the full size.** `findVisiblePhoto` (`media/repo.ts`) serves another account's photo only in the thumb and card sizes. A request for the full size gets what a photo never shown gets: the same 404 `not_found`, the same `photo refused` line with `reason: not_visible`, and nothing written to the fetch log. This amends ADR-008 §3. Unchanged:
   - one's own photos, in every size;
   - a photo sent in a conversation (`purpose = message`, served by the chat's routes, ADR-031 §10).

   A zoom on other people's photos, for example for low-vision people, would lift the refusal in a change of its own.
4. **Screenshots are never noticed**, on either platform. There is no `expo-screen-capture`, no listener, no notice to anyone and no count. If a line about other people's photos is wanted, it belongs in the community guidelines, where it reaches everyone and detects nothing.

## Consequences

- A script with a person's session no longer gets other people's photos at full size. It still gets two things the app does not ask for: the card size of a card's other photos, and photos of people shown on earlier days. Both stay under the card budget and ADR-041's pace (Open 4). Beyond those, what remains of TD-6 is a person capturing their own screen, which nothing here was meant to stop.
- ADR-041's `photo_fetches` counts card URLs from here on. A full-size row of another person's photo was issued before this change, and it counts while it is inside the window. The panel's text ("in the card and full sizes") stays true of what the rule counts.
- No native build, no new dependency, no Google account and no new personal data. The fingerprint does not move.
- The door that ADR-027 names, a sign-in started by another app or by a desktop script, stays open until #184's verified links or §2's attestation.
- An iPhone owner can still read their own tokens through a proxy. Certificate pinning would close that (Alternatives).
- Nobody is told of a screenshot. Blind users, people showing a match to a friend and people keeping evidence are not singled out.

## Alternatives considered

- **Attestation now, recording only.** `@expo/app-integrity` at sign-in, with `attested` on the session for ADR-041 to weigh. Nothing would be refused. But it costs a native build, about 300 lines of verifier for each platform, a Google service-account key in SSM and Google as a controller, all for a mark a script avoids by not attesting. On Android before Play it would mark every phone, the team's builds and the emulators included.
- **Attestation now, refusing.** It locks out de-Googled and Huawei phones, Macs, and every simulator and emulator. It needs exemptions for the demo tools and the load smoke. On iOS it may vouch for JavaScript a person serves the app while updates are unsigned.
- **Firebase App Check.** It wraps both vendors and issues short-lived tokens the API checks locally. But it adds Firebase to the trust path, and its Play Integrity provider still needs distribution from Play to fetch a token.
- **Counting another's full size as a velocity rule** (ADR-041's candidate) instead of refusing it. That gives the moderators a queue for a fetch the app never makes. The refusal is simpler, and it tells a script nothing that a missing photo does not.
- **A screenshot notice to the owner.** It is a desirability signal and a real-time push (Product constraints), an event about two people, and an accusation against the people who take screenshots for good reasons.
- **A screenshot count for the moderators.** It catches the wrong people, could reveal a disability (special-category data), and needs a consent under ePrivacy Art. 5(3) that a harvester would refuse.
- **A one-time reminder on the phone, iOS only.** Legally the lightest. But it needs a native module whose Android side announces every screenshot, three reviewed strings and a screen-reader walk, and nothing shows that a reminder changes anything.
- **Certificate pinning** (`NSPinnedDomains`, Android's network security config). It closes the cheapest way to read one's own token, and the update path too if Expo's host were pinned. Left out because it costs an open-source app its auditability, and a certificate change it misses cuts the app off until a new build.

## Open, the maintainer's

1. Whether certificate pinning gets an issue of its own.
2. Whether keeping evidence should need no screenshot: a frozen copy of a reported card (ADR-030 left it out), and the other person's lines in the export (ADR-031 Open 3).
3. A line in the community guidelines about other people's photos (§4).
4. Whether to close the two other differences of the Context: the card size served only of a card's main photo, and another's photos only from today's shown records. Each needs its edge cases looked at first: a photo reordered after the card was served, a round open across midnight, a match's photos after the day it was made.

## History

- 2026-10-25: written with the rest of #86, on the maintainer's decisions of that day. #86's body holds the research behind it.
