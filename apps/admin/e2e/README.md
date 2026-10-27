# The panel's flows

The moderation panel driven in Chromium by Playwright, against the real API, the mock bank and the host's content security policy (#106, ADR-051). The phone app's flows are Maestro's (`apps/mobile/e2e`, ADR-020).

## Running them

Once, the browser: `cd apps/admin && npx playwright install chromium`. Then, with docker compose's services up (`docker compose up -d --wait`, or `pnpm env:up`) and the pictures fetched (`pnpm demo:assets`):

```bash
pnpm e2e:admin
```

Playwright's own flags and file names pass through: `pnpm e2e:admin -- --headed`, `pnpm e2e:admin -- e2e/photos.spec.ts`, `pnpm e2e:admin -- --debug`. A run takes about half a minute on a laptop. `node apps/admin/e2e/run.ts --self-test` checks the reading of the host's headers, the arguments, the guards on the database and the store, and the panel's server, and starts nothing.

`run.ts` brings up what the flows need and takes it down afterwards, whether they passed or not:

1. `kuutti_test_admin_e2e` in Postgres and the bucket `kuutti-test-admin-e2e` in the S3 stand-in, both made anew; the database migrated and seeded. Never the shared `kuutti` database or `kuutti-media` bucket: other sessions use them, and the run refuses any database not named `kuutti_test_…` and any server or store not on this computer. The bucket is its own because a photo's objects are named by their content, the same in every database: an erasure in a shared bucket, judging by one database's rows, takes the other database's photos.
2. The API from source on a free port against both, configured from `env.example` (never `.env`).
3. The cast's stories (`demo:reset`), so Noa's photos wait in the queue; Mikael signs in once and is made a moderator with the maintainer's command line (`moderator recent`, then `grant`); Laura reports her conversation with Emmi; Iida's round names Riikka, the person of the sanction flow.
4. The panel's production build against that API, on another free port, with the headers of `infra/modules/admin/main.tf` read from the file. The one local addition is the S3 stand-in in `img-src`, where the local API's photo URLs point.
5. The flows, then everything stopped, the bucket emptied and removed, the database dropped, a Ctrl+C included. A run killed outright leaves both to the next run, which makes them anew.

One run at a time on a machine: a run holds an advisory lock on the database server, and a second one, from another worktree too, stops at once and says so.

What each step wrote is in `e2e/.out/setup.log`, the API's log in `e2e/.out/api.log`, a failed flow's trace and screenshot in `e2e/.out/results` (`npx playwright show-trace <trace.zip>`). CI keeps the same files as the run's artifact.

## The flows

| file | what a moderator does |
|---|---|
| `sign-in.spec.ts` | signs in at the bank and sees what waits; comes back to the screen they asked for; a bank login without a role is refused in words; the host's CSP refuses a style written at run time, and the guard sees it |
| `photos.spec.ts` | approves one photo and rejects another for a reason chosen on purpose; the picture loads through its signed URL; the count goes down |
| `report.spec.ts` | opens Laura's report, reads its frozen conversation, dismisses it through its confirm step |
| `sanctions.spec.ts` | finds Riikka's page by account id, applies a suspension and lifts it, each through a confirm step; a confirm step by keyboard alone; takes down one of her approved photos for a reason chosen on purpose, and the page says so |
| `roles.spec.ts` | an admin's screen (`/config`, `/audit`, `/staff`) answers a moderator with its refusal and asks the API nothing |

Every flow runs under a guard (`fixtures.ts`): any console error or warning, uncaught error or CSP violation on the panel fails it. The one exception is Saiga's absence (ADR-052): the build names its faces under `/fonts/`, which no runner has, and the browser's two warnings that it could not read one are expected. Flows match the panel's English texts of `messages.yaml`; a changed text breaks a flow, and the flow changes with it. They share one database and one worker, and none relies on another having run: a flow that decides something leaves it decided, and the next one reads what is there. For the same reason a flow cannot be retried on one stack (`--retries`, `--repeat-each`): its photos are decided and its report dismissed. A flaky flow is fixed, not retried.

## Writing one

- Sign in with `signInAsModerator(page, path)` from `fixtures.ts`, which goes through the bank as a person does, and lands on `path`.
- Reach elements by role and accessible name, as a screen reader does; scope to a region or a card (`[data-slot="card"]` filtered by its heading) where a text repeats.
- Data a flow needs beyond the stories is made in `run.ts`'s `cast()`, through the API's own routes as a persona, never with SQL.
- Keep to what only a browser shows. A screen's branches and errors are its Vitest tests (ADR-021).
