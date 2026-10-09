# The demo storyboard

The first ten minutes of Kuutti, shown with the demo personas (#144, ADR-014, ADR-018). The same story runs in the simulator against the mock bank and on the staging phone against Telia's test banks; only the sign-in differs. `runbook.md` says how to prepare either. What a screen says is quoted from the catalogue as of 09/10/2026 (English); the app follows the phone's language.

The personas and their banks: `services/mock-idp/README.md`. Locally every persona is a button on the mock bank's page; on staging each is a test user of a bank (`docs/vendors/telia.md` 1.4), and the stories were written by the job of ADR-018.

## Scene 1: Aino signs in (2 min)

Aino Virtanen is a newcomer: Kuutti has never seen her.

1. Open the app. The first screen is the sign-in: "Kuutti verifies every account through a Finnish bank. Your bank confirms who you are; Kuutti keeps only your year and month of birth and a code that cannot be turned back into you." One button, "Sign in with your bank".
2. Tap it. The system browser opens the bank chooser. Locally: the mock bank's page, tap **Aino Virtanen**. On staging: Telia's chooser, choose **Nordea**, user `DEMOUSER2`, confirm on the bank's test page.
3. The bank sends the browser back; the app receives its one-time code and shows the session. Say what happened: the code was parsed, the age checked, the HMAC derived, the code discarded; nothing of the bank's name for her is kept (rule 1 and 3).

## Scene 2: Onboarding (3 min)

The steps in the order the sheet asks them (ADR-010, #146), one screen each, "Continue" at the bottom and the progress above.

1. Welcome: how Kuutti does things, and the two consents, terms and privacy, with their version. One tap.
2. Name: what the card will call her. Type "Aino".
3. Gender: self-declared; the identity label is offered after a non-binary answer only. Choose a woman.
4. Whom she seeks: one to three; under it the line "I consent to Kuutti storing whom I seek" (the article 9 consent, ADR-019 §4). Choose men.
5. Intent: long-term, casual, or open to either.
6. Age window: buttons, not a number field, around her own age.
7. Photos: "Add photos", at least three. From the camera roll: her three pictures (the runbook put them there). Each goes through the pipeline: resized, EXIF stripped, three variants, a blurhash, the check. Locally the check queues everything, so the grid shows them pending; on staging Rekognition approves a face within seconds.
8. "A few words": two prompts of twelve, or a bio of fifty characters.
9. Done. The pond is assigned by the API (one country-wide pond, "Suomi"); there is no pond step.

The account is active once the four matching answers and the two consents are there (ADR-010 §6); the profile steps may be finished later.

## Scene 3: The gate (1 min)

The home screen: "Kuutti", two cards and the ways onward.

- "People in your area": the counter of the pond, in tens, with the split by gender when every cell is at least ten, and "n people are still finishing their profile." (ADR-013). With the population written, the numbers are of a pond over the gate.
- "Matching": where Aino stands. With her photos pending: "Matching opens for finished profiles. Yours still lacks something." Once her three photos are approved: "Your profile is finished. Where you stand is counted tonight." After the count (the runbook runs it): "You are among the next 10 in line for your area." or "Matching is open for you." (ADR-015: the women of the population are the smaller group, so she is let in; a man of the larger group is told his place in line).
- Below: "Your profile", "Your photos", "Fill in the rest while you wait" (the optional fields, one per screen, "Ask me later" on each, #148), "Your deal-breakers" (up to two, only on what she answered herself, #149).

Show "Fill in the rest while you wait" for one field and skip it; show "Your deal-breakers": the field she has not answered says "To filter on this, share yours first."

## Scene 4: Sanna's card (1 min)

Sign out (Settings, "Log out") and sign in as Sanna Korhonen (locally her button; on staging Nordea `DEMOUSER4`). Her story is complete: a profile, three approved photos, the gate open.

- Home: "Matching is open for you."
- "Your profile" → "See your card": the card as others see it (#150): the first photo, "Sanna", "49, age verified by your bank", "Woman", the pond, one prompt answer, the other photos, the fields that are information (languages by their own names, "Something long-term", the hobbies, "171 cm"), nothing that is a setting or a soft preference.

## Scene 5: The moderation queue (2 min)

Noa Salmi's story uploaded two faces and four pictures the check is meant to refuse (#142): no face, several people, text, and one whose EXIF carried a location (which the pipeline stripped, so it is a face like any other and is approved).

1. The admin panel (the runbook says where): sign in as the moderator through the bank.
2. The queue lists the three: what the check saw (labels, faces), the picture, "Approve" and "Reject" with a reason from the list (no person, several people, text with contact details, and so on). Reject the one without a face as "no person".
3. In the app, as Noa (locally her button; on staging Nordea `DEMOUSER3`): "Your photos" shows the rejection with its reason in her language; her card shows the two approved faces; the gate says her profile still lacks something (two of three).

## Scene 6: Refusals (1 min)

Two logins the product refuses, by the code that refuses anybody (TD-7).

- Ilona Öhman (locally her button; on staging Aktia, prefilled): she deleted her account in her story. The sign-in says "You deleted your account recently. The earliest day for a new one: …" with the day thirty days after her story was written, as d.M.yyyy (#150).
- Tapio Heikkinen (locally his button; on staging OP, prefilled): banned. "This person may not use Kuutti."

## Scene 7: The person's data (1 min)

As Aino again: Settings → the account card.

- "Your Kuutti data": the export, everything held about her, as JSON (ADR-007): the account, the profile, the preferences and deal-breakers, every consent ever given, the research mapping, the photos with short-lived links.
- "Delete your account?" → "Delete everything": the erasure path. She is signed out; a sign-in within thirty days is refused with the date, as Ilona's was.

Then `pnpm demo:reset` (locally) or the reset in the container (staging): everybody back to where they begin, the stories told anew.

## What is deliberately not shown

No swipes, no scores, no streaks, no "people who liked you", no feed (CLAUDE.md, Product constraints). Rounds, likes and chat are M4; the demo ends at the gate.
