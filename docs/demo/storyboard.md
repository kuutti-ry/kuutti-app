# The demo storyboard

The first ten minutes of Kuutti, shown with the demo personas (#144, ADR-014, ADR-018). The story runs in the simulator against the mock bank and, all but scene 5, on the staging phone against Telia's test banks; only the sign-in differs. Scene 5, the round, runs in the simulator only (#379; the scene says why). `runbook.md` says how to prepare either. What a screen says is quoted from the catalogue as of 09/10/2026 (English); the app follows the phone's language.

The personas and their banks: `services/mock-idp/README.md`. Locally every persona is a button on the mock bank's page; on staging each persona of the other scenes is a test user of a bank (`docs/vendors/telia.md` 1.4), and the stories were written by the job of ADR-018.

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
7. Photos: "Add photos", at least three. From the camera roll: three or more of her five pictures (the runbook put them there). Each goes through the pipeline: resized, EXIF stripped, three variants, a blurhash, the check. Locally the check queues everything, so the grid shows them pending; on staging Rekognition approves a face within seconds.
8. "A few words": two prompts of twelve, or a bio of fifty characters.
9. Done. The pond is assigned by the API (one pond for now, "Pääkaupunkiseutu"); there is no pond step.

The account is active once the four matching answers and the two consents are there (ADR-010 §6); the profile steps may be finished later.

## Scene 3: The gate (1 min)

The home screen: "Kuutti", two cards and the way onward.

- "People in your area": the counter of the pond, in tens, with the split by gender when every cell is at least ten, and "n people are still finishing their profile." (ADR-013). With the population written, the numbers are of a pond over the gate.
- "Matching": where Aino stands. With her photos pending: "Matching opens for finished profiles. Yours still lacks something." Once her photos are approved: "Your profile is finished. Where you stand is counted tonight." After the count (the runbook runs it): "You are among the next 10 in line for your area." or "Matching is open for you." (ADR-015: the women of the population are the smaller group, so she is let in; a man of the larger group is told his place in line).
- Below: "Your profile". The profile list holds the rest (#239): "Photos" and the sections, each with a check mark once done or how far it is filled, then "Your deal-breakers" (up to two, only on what she answered herself, #149) and, while a question is unanswered, "Fill in the rest while you wait" (the optional fields, one per screen, "Ask me later" on each, #148). The eye at the top opens her card.

In "Your profile", show "Fill in the rest while you wait" for one field and skip it; show "Your deal-breakers": the field she has not answered says "To filter on this, share yours first."

## Scene 4: Sanna's card (1 min)

Sign out (Settings, "Log out") and sign in as Sanna Korhonen (locally her button; on staging Nordea `DEMOUSER4`). Her story is complete: a profile, five approved photos, the gate open.

- Home: "Matching is open for you."
- "Your profile" → the eye, "See your card": the card as others see it (#150): the first photo, "Sanna, 49", "Woman", the pond, one prompt answer, the other photos, the fields that are information (languages named in the reader's language, "Something long-term", the hobbies, "171 cm"), nothing that is a setting or a soft preference.

## Scene 5: Today's round (3 min)

Locally only. Sign out and sign in as Iida Mattila (her button). She and the four women of her round exist at the mock bank only: on staging the job gives their stories and her round too, and nobody signs in as any of them there (ADR-018 §1), so this scene has no staging version. A round on staging for a persona of Telia's bed, whom the phone can sign in as, is the maintainer's open decision (ADR-014, Open 1). Her story is complete: a profile, three approved photos (release v3 of the pictures), and her gate opened by the stories, since four people are no pool the night's count would open a gate for (`gate_k`, ADR-015). The four women of her round, Henna, Katja, Minna and Riikka, have stories too, and Henna liked Iida yesterday (#379).

Her round is right only on the Finnish day of the reset that built it. On a later day the builder makes her a round of Henna alone: Katja, Minna and Riikka were shown on the reset's day and wait out `shown_cooldown_days` (thirty, TD-12), and Henna's like still waits while Iida has not decided on her card (once she has, the round is empty). So the reset for this scene is run on the morning of the demo, and the morning's checks sign in as Iida (`runbook.md`).

1. Home: "Matching is open for you." and under it "Today's round".
2. The first card is Henna's, labelled "Liked you": a like waits first in the round, and never unlabelled (ADR-037). Like and Pass are buttons at the bottom, never a swipe: Pass an outlined rectangle at the left, Like a filled pill at the right, each with its word. On her card there is no fish: a fish would only answer her like.
3. Like: "It's a match", and "Go to the conversation" opens it, empty but for the composer (ADR-038). Back returns to the round.
4. The next card says "Matches your filters". Show "Send a fish" above Like and Pass: one a week, first in the other person's round (ADR-039). Pass, then Undo in the header: the card comes back with "You passed on this person. You can change that until midnight." (ADR-034 §5). Like.
5. The third card: "Block or report" beside the name, the same dialog as anywhere (ADR-030 §11). Report and block, a reason, a few words, Send report; Done, and the card is gone.
6. The last card, then "That was today's round. The next one comes tomorrow." No count, no countdown, nothing loads more.

Which of Katja, Minna and Riikka comes when is the day's order (the soft matches, ties by a hash of the day, ADR-035), so tell it by the cards, not by a script. Once a release carries faces for the population's pool (v2 has none), a population with faces written before the reset may put women of it whom Iida's pool takes in among them, and into her later rounds too. A match and a report are final: `pnpm demo:reset` gives Iida her round anew, for the day it runs.

## Scene 6: The moderation queue (2 min)

Noa Salmi's story uploaded two faces and four more pictures for the check (#142): no face, several people, text, and one whose EXIF carried a location (which the pipeline stripped, so it is a face like any other). On staging the check decides all of them itself (ADR-006 §2, #206, #253): the landscape, the page of text and the group picture are rejected with the reason in words, the faces and the EXIF one approved, and the queue stays empty, which is the point. Locally, where the check queues everything, the queue holds all but her first face: show the queue there.

1. The admin panel (the runbook says where; locally for this scene): sign in as the moderator through the bank.
2. The queue lists Noa's pictures: what the check saw (labels, faces), the picture, "Approve" and "Reject" with a reason from the list (no person, several people, text with contact details, and so on). Reject the one without a face as "no person".
3. In the app, as Noa (locally her button; on staging Nordea `DEMOUSER3`): "Your profile" → "Photos" shows the rejection with its reason in her language; on staging her three pictures say the same kind of thing without anybody having looked ("A profile photo has to show you", "A profile photo shows you alone"). On staging her card shows her faces and the EXIF one, and her profile is complete; locally her card shows the one approved face and the gate says her profile still lacks something (one of two).

## Scene 7: Refusals (1 min)

Two logins the product refuses, by the code that refuses anybody (TD-7).

- Ilona Öhman (locally her button; on staging Aktia, prefilled): she deleted her account in her story. The sign-in says "You deleted your account recently. The earliest day for a new one: …" with the day thirty days after her story was written, as d.M.yyyy (#150).
- Tapio Heikkinen (locally his button; on staging OP, prefilled): banned. "This person may not use Kuutti."

## Scene 8: The person's data (1 min)

As Aino again: Settings → the account card.

- "Your Kuutti data": the export, everything held about her, as JSON (ADR-007): the account, the profile, the preferences and deal-breakers, every consent ever given, the research mapping, the photos with short-lived links.
- "Delete your account?" → "Delete everything": the erasure path. She is signed out; a sign-in within thirty days is refused with the date, as Ilona's was.

Then `pnpm demo:reset` (locally) or the reset in the container (staging): everybody back to where they begin, the stories told anew.

## What is deliberately not shown

No swipes, no scores, no streaks, no list of "people who liked you" (a like shows as a labelled card in the round, nothing more), no feed, no count of cards or likes (CLAUDE.md, Product constraints).
