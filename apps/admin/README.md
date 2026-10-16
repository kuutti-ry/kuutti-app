# @kuutti/admin

Vite + React moderation panel, built to static files and served behind CloudFront. Screens so far, each at its own path with a menu by role (#302): the staff sign-in (`src/features/identity`, #49, ADR-006), the photo review queue at `/photos` (`src/features/media`) and the feedback people sent from the app at `/feedback` (`src/features/safety`, #171), and for admins the tunables at `/config` (#304, #305); the front page is the first screen the role opens until #303. The rest arrives with the Admin milestone (#106). Rules: `.claude/rules/admin.md`.
