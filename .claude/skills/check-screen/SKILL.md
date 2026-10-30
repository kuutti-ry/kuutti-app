---
name: check-screen
description: Check a changed screen of the phone app or the moderation panel as a whole, running: the whole page, every state, both themes, the largest text, accessibility and the three languages. Use after changing anything a person sees, before saying it is done, and before open-pr; a hook refuses `gh pr create` on a branch that changes a screen until this skill has run in the session.
argument-hint: [screens]
---

A green test does not show that a screen is right. Look at the running screen. CLAUDE.md's Accessibility section and `.claude/rules/mobile.md` are the rule; `docs/accessibility-checklist.md` names the ten checks.

## 1. Run it

Run the branch, in the worktree, on a stack that is free. Other sessions share this computer's API, emulator, simulators and personas, so check `pnpm env:status` first. The panel and the app's web target run in the browser pane; what needs a phone runs on a simulator, which reaches this computer's server at localhost. Sign in as a persona that has what the screen needs; the personas exist at the mock bank only.

## 2. Look at the whole page

Not only what changed. From the header to the footer, and where the fold falls:

- at about 1000 x 550 CSS px, the maintainer's window, without scrolling;
- then scrolled to the end;
- then at 320 px wide, with no sideways scroll.

Compare with how it looked before the change. A change that fits on its own can still push something else off the screen.

## 3. Every state

Loading, empty, an error from the server, no network, a refusal in its own words, disabled and read-only (drawn, never faded), and the longest real content: a long name, a long bio, the longest of the three languages. Finnish is usually the longest. Test what a person can actually reach.

## 4. Text, theme, motion

- Light and dark, each with high contrast on. AA contrast in both, and meaning never by colour alone.
- The largest text the OS allows (`MAX_FONT_SCALE`): nothing clipped, no fixed-height container, every control still reachable. A screen's title stays on one line and no word breaks in the middle.
- Reduce motion: no animation plays and no tap buzzes.
- Finnish, Swedish and English, each with no raw key and no text cut off. The panel is in English.

## 5. Accessibility you can check

Every touchable has `accessibilityLabel` and `accessibilityRole` and a target of at least 44 pt. Decisions are buttons, never swipes, and pass and like differ in shape, label and position. Decorative images are silent, and what changes on its own is said where it changes. The component test asserts the role and the label.

## 6. The screen-reader walk

An agent cannot run a screen reader, and a jest check, a screenshot or a read of the code is no walk. Never claim one. Each changed screen is either walked by a person, with the screens, phones and walker named in the pull request, or pushed unwalked: the pull request says so and why, and a commit message carries `Unwalked: <screens>`. A screen or step added or removed adds or removes its row in `docs/accessibility-checklist.md`.

## 7. The flows

Run the Maestro or Playwright flows that touch the screen, only those. A flow names its texts in all three languages. A renamed flow needs its entry in `config.yaml`'s order renamed too.

## 8. Report

Show proof, not a claim: a screenshot of the whole page at each size, with what was looked at, and what could not be checked and why. If something looks wrong in a part you did not change, say so rather than leaving it out.
