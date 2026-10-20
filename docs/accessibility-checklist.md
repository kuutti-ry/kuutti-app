# Accessibility checklist

Every screen and step of the phone app, and what is listened for on each, with VoiceOver on an iPhone and TalkBack on an Android phone (#217). The whole chart is walked before each release, and before the first store builds (M6); between releases, a pull request that changes a screen walks that screen or says it is unwalked (`.claude/rules/mobile.md`), and the release pass walks the unwalked ones first and finds what those walks missed. The jest checks (`pressables` and `a11yProblems` in `apps/mobile/src/test/a11y.ts`, `pnpm --filter mobile check:contrast`) hold the rules of `CLAUDE.md` (Accessibility) on paper; this chart is what a person hears and sees on a phone. The moderation panel is not in it.

An empty cell is a screen nobody has walked on that platform. Nothing is claimed about a screen, in a pull request, an issue or on the site, beyond what a person walked: a cell here that holds a date, or a walk named in a pull request by the person who did it. A walk by the team is not a test with blind and partially sighted people (#217); a cell says only what its walker heard.

## The checks

Every row is walked with all ten, on each platform. They are numbered so that a failure can name one ("Photos, 3").

1. **Order.** Swiping through reaches every control and every line of text in the order they are read on screen. A dialog takes the focus when it opens, keeps it while open, and gives it back when it closes.
2. **Roles and names.** Each control says what it is (button, switch, text field, radio, header, link, image) and has a name that says what it does, in the app's language. No unlabelled control; an icon button is heard by its label, never as "button" alone.
3. **State.** Selected, checked, on or off, dimmed, and a value (a stepper's years, a row's progress) are said, not only drawn.
4. **Decorative images silent.** The mark, the glyphs of #213, the chevrons, the progress marks and a language's flag are never reached. A photo is reached and heard by its label: its place, the owner's caption, then the automatic description, in that order (#296).
5. **Live regions.** What changes without a tap of its own is said where it changes, without moving the focus: a step's progress, the gate, a loading line, an error, a saved line. React Native's `accessibilityLiveRegion` is marked `@platform android`, and as this chart is written the app makes no announcement of its own on iOS (`AccessibilityInfo.announceForAccessibility`), so listen for this one in the iOS column above all.
6. **Largest text.** iOS: Settings, Accessibility, Display & Text Size, Larger Text, with Larger Accessibility Sizes on and the slider at the end. Android: Font size and Display size at the largest. Nothing clipped, cut off or overlapping, every line reachable by scrolling. The app scales text up to `MAX_FONT_SCALE` (2×, `apps/mobile/src/theme/a11y.ts`); the screen holds at the phone's largest all the same. A screenshot of each screen at this size goes with the record.
7. **44 pt.** Every touch target still at least 44 pt at the largest text (`TOUCH_TARGET`, `hitSlopFor`): the chips, the steppers' buttons, the switches, the photo tiles' buttons, the dialogs' close. Android's Accessibility Scanner flags small targets and missing labels; it is an aid, not the walk.
8. **Reduce motion and haptics.** iOS: Reduce Motion; Android: Remove animations. No animation plays and no tap buzzes (`useReducedMotion`, `useMotionDuration`, `useHapticTap`). The photo drag itself stays, as direct manipulation; its lift, slides and settling do not.
9. **High contrast, in both themes.** iOS: Increase Contrast; Android: High contrast text; or the app's own switch, Settings, Theme. In light and in dark, the high-contrast set is drawn: look at the outlines of the chips and switches, the dimmed states, and whatever lies over a photo.
10. **No gesture alone; keyboard and switch.** Everything the screen does is reachable by single taps on named controls, with the reader and without it: no drag, long press or swipe is the only way (the photo tiles' actions, #179; a back button where the edge swipe is off). With an external keyboard (Full Keyboard Access on iOS, an iPad or an Android phone) or Switch Control / Switch Access, the focus is visible and every control is reached.

## Setting up

- **Phones.** A real iPhone and a real Android phone, with the build the pass is for: the `preview` build on the `staging` channel, or the dev client (`docs/runbooks/devices.md`). The iOS Simulator has no VoiceOver, and the Accessibility Inspector, a jest run, a screenshot or a read of the code is no walk.
- **People.** The personas, on staging through Telia's test banks (`services/mock-idp/README.md`): Aino for the sign-in, every onboarding step and the later questions; Sanna for a finished profile with photos; Noa for photos rejected with their reasons; Kerttu for the terms asked again; Helmi for the break, and for the profile's list of what the card still needs (onboarded, no photos); Tapio and Ilona for the refused sign-ins. Antti and Ville, for the conversations (Antti's silent match with Sanna is in his archive), Elina and Jussi, for a contact shared in a conversation (#103), Laura and Emmi, for a report from a conversation (#351; a report blocks for good, so reset after the walk), and Eetu, Venla, Lauri and Siiri exist at the local mock bank only, so the age refusals are walked with a dev client against the local environment. So is a photo in review: on staging the check decides Noa's pictures itself and her profile is complete, while locally it queues everything and her profile lists what is missing. A walk that changes its persona (onboarding, the break, the deletion) is followed by the reset (`docs/demo/runbook.md`).
- **Order of a pass.** One platform at a time: the reader through every row at the default text size (checks 1 to 5); again at the largest text with reduced motion on, a screenshot of each screen (6 to 8); high contrast in light and in dark (9); the keyboard or a switch (10). The rows are in the order a newcomer meets the screens.

## The record

A cell holds the date (dd/mm/yyyy) and the walker's name; a check that failed is added with its number and its issue (`dd/mm/yyyy name; 5 #n`). Only the person who walked the row fills its cell, in a pull request; an agent never does. A full pass also leaves one comment per platform on its issue: the screens walked, what was heard where it was not what this chart expects, and the screenshots at the largest text. What fails becomes an issue, or a fix in the pass's own change when it is a one-liner, with a jest assertion where one would have caught it.

## Repeating it before a release

1. A pull request that adds a screen or a step adds its row here; one that removes it removes the row. The chart is the app as it is.
2. Before each release (a tag `vX.Y.Z`, `CLAUDE.md` Git) an issue is opened for the pass, naming the version and the build walked. The first pass is #217's.
3. The screens merged unwalked since the last release come first: `git log <last tag>..origin/main --grep '^Unwalked:'` lists them, from the line an agent's commit carries (`.claude/rules/mobile.md`).
4. Every row is walked on both platforms on that build, as above, and the cells are replaced with the new dates in a pull request that refs the pass's issue. The earlier pass stays in this file's history.

## The chart

### Across the app

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| The screen-reader hint (#296) | any, on the first launch with the reader on | the dialog over the first screen: its title and text, the close and both buttons named; dismissed, it never shows again on that phone: Android forgets it when the app's storage is cleared, but iOS keeps it in the Keychain through a reinstall, so on an iPhone it is walked the first time it shows | | |
| A screen that did not load | any (`LoadFailed`), with the network off | the screen's own line, the reason in words, and the way out (Try again, or the update) as a named button | | |
| Leave without saving? | a section after a refused save, a later question or the deal-breakers with a change unsaved | the dialog takes the focus; keep editing and leave named; Android's back key asks too | | |

### Signing in

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Start, signed out | `/` | the loading line said; the title a header; the explanation; Sign in with your bank | | |
| Back from the bank | `/auth?code=…` | the system browser and the bank's pages are not ours, so the walk resumes at the return; opening, signing in and done said as they change | | |
| Refused | `/auth?error=…` (Tapio, Ilona, Lauri, Venla) | the card's title and its sentence, with the date where there is one; Try again named | | |
| Right after a break | `/` (Helmi, after Take a break) | the sign-in with the paused card: its title and text | | |

### Onboarding

`/onboarding`, Aino (ADR-010). On every step: the title a header, "Step x of n" said as it changes, a refused step said, and Continue heard as dimmed until the step is answered.

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Loading, or not loaded | `/onboarding` | the loading line said; the failure and Try again | | |
| Welcome | `/onboarding` | the four lines on how Kuutti does things; the terms and privacy cards with their versions in order; the accept button, and the step asked again for a wording accepted before (Kerttu); the line that says the app is older than the wording shows only on a build older than the API's wording, so a current build does not meet it | | |
| Name | `/onboarding` | the field named as the display name | | |
| Gender | `/onboarding` | three choices, the chosen one heard as selected | | |
| Identity label | `/onboarding`, after non-binary only | the label's choices; Continue and the skip | | |
| Whom you seek | `/onboarding` | three choices and Anyone, which selects all three; the sensitive-answers card with its switch, on or off, dimmed once given | | |
| Intent | `/onboarding` | the choices, one selected | | |
| Age window | `/onboarding` | two steppers: each value heard in years as it changes, the four buttons named, dimmed at a bound | | |
| Area | `/onboarding`, only where more than one area exists | each area a named button; loading and the failed line said, Try again | | |
| Photos | `/onboarding` | one button to the photos screen (Photos, below), and back to this step | | |
| A few words | `/onboarding` | the bio field and its ready lines; the prompts, each picked and answered; the save heard as dimmed until the words count | | |
| Research | `/onboarding` | the card and its version; Yes and Not now named; then the done line, and home | | |

### Home

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Home, signed in | `/` (Sanna) | Settings and Tech config named (Tech config outside production only); the mark silent; the title a header; welcome back said once after a break (Helmi); the gate's checking line said, and its failure; the area card's figures in words, none below the threshold; the gate card in words, nothing on it tappable but, once matching is open (Iida), Today's round named; the button to the profile | | |
| Home, a notice (#176) | `/` (a person a moderator warned) | Notices a header, first in the list; the warning's title and its reason heard in order; Got it named; after it the notice gone and the focus not lost; a failure said (VoiceOver is told, TalkBack reads the region); nothing at all without a notice | | |

### Today's round

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| A round card (#379) | `/round` (Iida, after `pnpm demo:reset`) | back named Back to home; the title a header; the loading line said, the failure and Try again; the focus taken to the card's reason as each card comes ("Liked you", "Matches your filters"), then the photo with its label, the name with the age as a header with its Block or report action, and the card's words; Block or report named beside the name; Pass, Like and, on a card that answers nobody's like, Send a fish, each named, at least 44 points, heard as dimmed while a decision is on its way; no swipe does anything | | |
| Undo (#379) | `/round` (Iida, after a decision) | Undo heard as "Undo your last decision", absent before the first decision and after a match; the card that comes back says what was decided ("You passed on this person…"), and its button heard as selected | | |
| A match (#379) | `/round` (Iida, Like on Henna's card) | "It's a match" taken to and heard, the line under it, Go to the conversation and Back to the round named; back from the conversation, the next card | | |
| The round's words (#379) | `/round` (Iida, the last card decided; a reset without the stories for none) | "That was today's round…", the empty round and the round not ready yet each taken to and heard; a notice (the day ended, a card gone, the likes or the fish used up, a like that made a match) said once without moving the focus (VoiceOver is told, TalkBack reads the region); no count anywhere | | |

### Conversations

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Home's Conversations button | `/` (Antti: one unread; Sanna: none) | named Conversations with the unread count in words ("nothing unread" at none); the mark beside it silent | | |
| Conversations | `/chats` (Antti) | back named; the loading line said, the failure and Try again; the empty line; the Open and Archived headers and the archive's line; each row heard once, as the name and age (or Deleted user), the unread count in words, the last line (You: before one's own, or how a closed one ended) and its time or day; the thumb and the mark silent; pull to refresh is not the only way: the list reads again on returning to it | | |
| A conversation | `/chats/<id>` (Antti's with Ville) | the name and age as the header; Earlier messages a named button where there are more; each day line; each message heard once as who, when and what, the time under it silent; Read under the last one read; the field named Message with its placeholder; the characters left; Send named, heard as dimmed while empty or too long; Sending… under a message on its way; a refusal (a phone number) said under the field with the words kept | | |
| An archived conversation | `/chats/<id>` (Antti's with Sanna) | the line that writing brings it back, above the field; gone after a message | | |
| A closed conversation | `/chats/<id>` (Ville's, after Antti deletes his account) | no field and no Send; the ending said in its place: deleted their account, or ended, never blocked; no More, since it can no longer be reported (#351) | | |
| An ended conversation (#351) | `/chats/<id>` (Emmi's, after Laura reports her) | Conversation ended as the header, no name anywhere; the other side's messages heard as "The other person"; the ending said where the composer was; More named, holding only Report and block while it can be reported, and absent after; its row in the list heard as Conversation ended with the last line | | |
| A conversation's More (#351) | `/chats/<id>` (Laura's with Emmi) | More named, beside Share contact, its icon silent, at least 44 points; the dialog takes the focus at its title, Report, block or end; Block, Report and block and End conversation each with its line; each confirmation's title takes the focus, its words read before its buttons; the report's copy sentence, then that it ends the conversation, the reasons as a radio group and the note as on a card, the note's field, focused, in sight above the keyboard with its label (on Android, Send report too); a failure said in words with the dialog kept; Cancel and Close named | | |
| The list after an action (#351) | `/chats` (Laura, after reporting Emmi) | back on the list, the thanks (or Blocked, or The conversation has ended) heard once, VoiceOver told and TalkBack reading the region; not said again on the next visit | | |
| A conversation's Add photo (#350) | `/chats/<id>` (Antti's with Ville) | Add photo named, beside the field, its icon silent; heard as dimmed while a message is on its way; absent in a closed conversation; the phone's library opens; the library refused (photo access off in the phone's settings) said under the field | | |
| The attached photo (#350) | `/chats/<id>` (Antti's with Ville), a photo picked | "Photo attached. The words in the field go under it." said without interrupting, the small picture silent; Remove photo named, and the photo gone after it with the words kept; Send no longer dimmed with an empty field | | |
| A photo on its way (#350) | `/chats/<id>` (Antti's with Ville), Send with a photo | the row heard once as You, the time and the caption (or Photo); "Sending… n %" said without interrupting as it goes, and gone once the photo is there; a refusal said under the field with the words kept (locally: the day's eleventh photo) | | |
| A photo in a conversation (#350) | `/chats/<id>` (Ville's with Antti, after Antti sent one) | one button, heard as who, when and the caption (or Photo), then the automatic description where the check gave one, and the hint that it opens full size; the picture and the caption under it not heard twice | | |
| Photo removed (#350) | `/chats/<id>` (Ville's, after Antti sent a photo and deleted his account) | "Photo removed" heard after who and when, with the caption after it if there was one; not a button | | |
| A photo full size (#350) | `/chats/photo/<messageId>` (Ville, from Antti's photo) | Photo as the header, the arrow named Back to the conversation; Loading the photo… said; the photo heard as "Photo, full size", the caption, then the automatic description; the description under it only with Show under photos on, not heard twice; a photo no longer there said, with Try again after a failure; leaving takes the back button, no pinch | | |
| A conversation, live (#349) | `/chats/<id>` (Antti's with Ville, Ville on a second phone) | a message from the other phone appears without leaving the screen and is heard once when reached; Read appears under one's own once they read it; Online under the header, heard as a word, the dot beside it silent, gone when they close the app and on a closed conversation; a message sent shows Sending… only until it is there | | |
| Share contact (#103) | `/chats/<id>` (Elina's with Jussi, a contact kept in Settings) | Share contact named, beside the name in the header, its icon silent; absent with no contact kept and in an ended conversation; the dialog takes the focus at its title; the sentence that they see it at once and that what they wrote down stays with them; each contact heard as its kind and value; Share or Stop sharing heard with the kind ("Share your Instagram"), never with the value, and "Shared in this conversation" under one shared; the outcome said without moving the focus (VoiceOver is told, TalkBack reads the region); a refusal said in words (the contact removed on another phone); Close named | | |
| A contact shared with you (#103) | `/chats/<id>` (Jussi's with Elina, after she shared one) | each line under the header heard once as who shares what ("Elina shares Instagram: …"), text that can be selected and copied, never a link or a button; gone when she stops sharing, and in an ended conversation | | |
| A contact shared live (#103) | `/chats/<id>` (Jussi's with Elina, Elina on a second phone) | a line that appears while the screen is open said once, without moving the focus (VoiceOver is told, TalkBack reads the region); a changed one shows its new value; one taken back goes without a word | | |
| The connection line | `/chats` and `/chats/<id>` (Antti), flight mode on and off | "Connection lost. Reconnecting…" at the top, under the header, said once when it appears without interrupting (VoiceOver is told it, TalkBack reads the region); gone once the connection is back; the screen still usable under it | | |

### Profile

Sanna; Helmi and Noa where it says.

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Profile | `/profile` | back and See your card named; what the card still needs (Helmi, or Noa locally); each row heard by its title with its progress in words as its value, the ring, the count and the chevron silent | | |
| Basics | `/profile/section/basics` | the name field, the identity label's choices where one was given in onboarding (no persona has one: a sign-up that chose non-binary and a label), the bio and its ready lines, height as a stepper, languages with the search box; leaving by the back button saves; a refusal (a phone number in the bio) brings the section back with the reason said | | |
| Prompts | `/profile/section/prompts` | how many of three are answered; each prompt picked, answered and taken away | | |
| Relationship | `/profile/section/relationship` | intent, monogamy, kids and kids wanted, whose words follow the kids' answer | | |
| Work | `/profile/section/work` | education; field with its switch to hide from people in one's field; occupation with the search box; the title field | | |
| Lifestyle | `/profile/section/lifestyle` | smoking and nicotine, drinking, drugs, exercise, pets | | |
| Hobbies | `/profile/section/hobbies` | the hobbies in their groups, the search box, as many chosen as apply, each heard as selected | | |
| Beliefs | `/profile/section/beliefs` | politics with "none of them", which stands alone; religion; star sign | | |
| Your card | `/profile/card` | the explanation; each photo heard as its place, the owner's caption, then the automatic description, once (the caption under it is not heard twice, #296); the name and age, the gender and label; answers both share said in words; a photo refused for the day's budget said under the card; what is still missing | | |
| Deal-breakers | `/profile/deal-breakers` | one switch per field, named with the field, on or off; an unanswered field says to share one's own first, with its button (Noa); a paused one said in words; the accepted answers with the search box; the switch for people who did not answer; the save, then saved or failed said; the limit refused in words | | |

### The later questions

`/profile/later/<field>`, in this order, from the profile's invitation. A newcomer after onboarding (Aino) meets every one; someone further along, only the unanswered. On every one: "x of n" said, the explanation (on the first one), the field, Save and continue, Ask me later, and back.

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Kids | `/profile/later/hasKids` | the choices, one selected | | |
| Kids wanted | `/profile/later/wantsKids` | the choices' words follow the kids answer | | |
| Smoking | `/profile/later/smoking` | smoking, and nicotine on the same screen | | |
| Languages | `/profile/later/languages` | the first languages, then the search box; many chosen | | |
| Education | `/profile/later/education` | the choices, one selected | | |
| Drinking | `/profile/later/drinking` | the choices, one selected | | |
| Drugs | `/profile/later/drugsAttitude` | the choices, one selected | | |
| Hobbies | `/profile/later/hobbies` | the groups, the search box, many chosen | | |
| Height | `/profile/later/height` | a stepper: the value heard as it changes, both buttons named | | |
| Exercise | `/profile/later/exercise` | the choices, one selected | | |
| Pets | `/profile/later/pets` | the choices, as many as apply | | |
| Field | `/profile/later/field` | the fields, and the switch to hide from people in one's field | | |
| Occupation | `/profile/later/occupation` | the search box, and the title field | | |
| Politics | `/profile/later/politics` | the parties, and "none of them", which stands alone | | |
| Religion | `/profile/later/religion` | the choices, one selected | | |
| Star sign | `/profile/later/zodiac` | the choices, one selected | | |
| E-mail, the last | `/account/email` | the e-mail card (as in Settings), the deal-breakers button, Done | | |

### Photos

`/photos`, Sanna; Noa for a rejected photo, and locally for one in review; Aino from onboarding for the first upload.

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Photos | `/photos` | the title a header; the count said as it changes; a notice said, its dismiss named; each tile heard by its place, which one is main, its state in words (approved, in review, rejected and why), its caption and description; Caption, Ask a person to look (a rejected one) and Remove named, and which photo each is for; Done is the way back (the edge swipe is off) | | |
| Adding a photo | `/photos`, Add a photo | the system's picker is not ours; back in the app, the check, the resize and the upload said in words as they go; a tip about the main photo said once, its dismiss named (#297) | | |
| Reordering | `/photos`, a tile's actions | Move earlier, Move later, Make main photo reached through the actions (the rotor on iOS, the actions menu on TalkBack) and the new order heard (#179); with reduced motion nothing slides | | |
| Removing | `/photos`, Remove | the dialog takes the focus: its question, Cancel and Remove, the close named; afterwards the focus is back on the grid | | |
| Caption (#296) | `/photos`, Caption | the dialog's title and explanation; the lines as radios, the chosen one heard as checked, no caption among them; the list scrolls at the largest text; the close named | | |
| Full size | `/photos/<id>` | back named; the photo heard as its place, the caption, then the automatic description; the description under it only where the setting says | | |

### Settings

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Settings | `/settings` | back named; the section titles headers; each row by its title, with its state as the value (the theme, the language, the descriptions, a consent's on, off or outdated); the version a plain row, not a button | | |
| Theme | `/settings/theme` | the schemes, the chosen one said; High contrast, on or off; the screen redrawn in the chosen set | | |
| Language | `/settings/language` | each language by its name, the flag silent, the chosen one said; the screen in the new language at once | | |
| Photo descriptions (#296) | `/settings/photo-descriptions` | what they are; Show under photos and the three parts as switches, each on or off | | |
| Research | `/settings/consent/research` | the explanation; the switch, on or off; loading and a failed read said | | |
| Sensitive answers | `/settings/consent/special_category` | the switch; withdrawn, onboarding asks whom one seeks again (Noa) | | |
| Terms of use | `/settings/legal/terms` | the title a header; the summary and the version in order | | |
| Privacy | `/settings/legal/privacy` | as the terms | | |
| Source code | `/settings/source` | the address heard as text and as a link | | |
| Licences | `/settings/licenses` | the whole list reachable to its end, each package with its licence | | |
| This device | `/settings/device` | Log out and Log out everywhere named | | |
| E-mail | `/settings/email` | the field named; save and remove; a malformed address refused in words; the loading and the failed read said | | |
| Your contacts (#103) | `/settings/contacts` | the line that nobody sees them until one is shared; four cards, each title a header with what to type under it; each field named by its kind ("Your phone number"), the number pad for the two numbers; Save and Remove heard with the kind, Save dimmed while empty or unchanged, Remove only while one is kept; saved, removed, a refusal in words for the kind and a failure said, the words kept; the loading and the failed read said | | |
| Notifications (#176) | `/settings/notifications` | the line that nothing is sent to the phone yet; the four kinds as switches, each by its name with its line after it, on or off; a switch heard as dimmed while a change is on its way; a failed change said, the switch as it was; the loading and the failed read said, Try again named | | |
| Feedback (#171) | `/settings/feedback` | the four kinds as radios, the chosen one said; the text field named; Send; the thanks, the day's cap and a failure said, the words kept | | |
| Your account | `/settings/account` | Download my data (the share sheet or the folder picker after it is the system's), Take a break, Delete my account; the deletion's dialog names the waiting time | | |
| Taking a break | `/account/break` (Helmi) | the consequences as a list; the switch I understand what a break means; the button dimmed until it is on; working and failed said; then the sign-in with the paused card | | |

### Tech

| screen or step | route | listen for in particular | iOS, VoiceOver | Android, TalkBack |
|---|---|---|---|---|
| Tech config | `/tech` | outside production: the environment, the API's address and health with its loading said, the two commits, the native build, Send a test error, the source offer; in the store's build, the line that says it is not there | | |
