---
paths:
  - "apps/admin/**"
---

# Admin panel (Vite + React) rules

A static SPA built to S3 behind CloudFront on `admin.<domain>`; PR previews are a bucket prefix. It calls admin routes on the same Hono API.

- Components (decided in #302): plain React, `react-router`'s declarative routes (`BrowserRouter`, one path per screen), and the one stylesheet `src/styles.css`. No Refine, no shadcn (the panel has no Tailwind), no table library until a table needs sorting in the browser; a list pages on the server. The screens and the menu are one table in `src/app.tsx`, each with the roles it is shown to; the API's guard is what refuses.
- A screen the role does not open answers at its path with its heading and "Your role does not allow this", and asks the API for nothing (`NotForRole`, #304); the API's guard is what refuses.
- A screen's heading is `ScreenTitle` (`src/lib/screen-title.tsx`): it names the page's title and takes the focus after the person's own move inside the panel (`NavigationFocus` around the routes), never on a load, a reload or the front page's redirect. A list a screen loads from one route goes through `useList` (`src/lib/use-list.ts`). A 403 is said once by the shell (`admin.refused`) and taken back when a request is honoured again, never as the screen's or a row's own failure; a 401 ends the session.
- The bank returns staff to the panel's root; the panel remembers the path before the login and puts it back before the router starts (`features/identity/return-path.ts`).

- Auth: Telia login on web, allowlist by `hetu_hmac` (the `identity.hetu_hmac` column of #34, so the allowlist and the roles need no schema change: a `moderator_roles(identity_id, role)` table keyed by the identity row), roles moderator / admin / researcher checked server-side. Sessions 8 hours, no refresh.
- Launch screens: report queue (report, frozen conversation snapshot, both profiles by pseudonymous id, reporter history), photo review queue, actions warn / shadow-ban / suspend / ban with an appeal note, auto-shadow-ban threshold editor, `matching_config` editor.
- Every moderator action writes the immutable audit log (who, what, when, why). Photo views go through short-TTL signed URLs and are logged.
- Never auto-delete a photo, never expose a bulk export, never show `hetu_hmac` or `research_id` in the UI.
- English only. The accessibility rules in `CLAUDE.md` apply: keyboard navigation, labels, contrast.
- Same zod contracts from `packages/schema`; no hand-rolled fetch types.
