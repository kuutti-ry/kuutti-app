# The demo-day runbook

How a demo is prepared and checked, locally and on staging (#144). The story itself is `storyboard.md`; the people, `services/mock-idp/README.md`; the population, `population.md`; the pictures, `photo-prompts.md`. Dates are d.M.yyyy; times Helsinki.

## The evening before

### Locally (the simulator, the mock bank)

1. `pnpm env:up`: the database, the S3 stand-in, the mock bank, the API, Metro.
2. `pnpm demo:assets`: the release of pictures into `~/.cache/kuutti-demo-photos/v1`, verified. Without it nobody has a photo and the storyboard's photo scenes do not work.
3. `pnpm demo:reset`: everybody forgotten through the erasure path, then the six stories through the API's own routes, with their pictures (Sanna 3, Noa 2 + the queue's 4, Kerttu 3; the faces approved locally, the negatives queued), then the counter and the gates counted.
4. `pnpm demo:population -- --photos`: three hundred people in the one pond, with faces of the pool by seed; the counter and the gates counted anew.
5. Aino's camera roll: `xcrun simctl addmedia booted ~/.cache/kuutti-demo-photos/v1/faces/aino/1.jpg ~/.cache/kuutti-demo-photos/v1/faces/aino/2.jpg ~/.cache/kuutti-demo-photos/v1/faces/aino/3.jpg` (the simulator must be booted). On a device, AirDrop the three files.
6. `pnpm dev:mobile` and open the dev client on the simulator; the tech config screen (the wrench on the home screen) shows the API it talks to.
7. The admin panel: `pnpm dev:admin` at `http://localhost:5173`; the moderator is a persona that was given the role after its first login: `pnpm --filter @kuutti/db moderator -- grant <hetu_hmac> moderator --by "<your name>"`, the hash from the API's log line of that login (`infra/README.md`, Staff). Use Mikael: a moderator persona is spared by the reset, so never one with a story.

### On staging (the phone, Telia's test banks)

Staging holds no real person (ADR-018). The three commands run inside the API's container and nowhere else; `infra/README.md`, "The demo on staging", says how to reach it. In order:

1. `pnpm demo:assets` once in the container's cache (`gh` with read access to the private repository), or copy the verified cache in; the job refuses a cache that is not the release's.
2. `node dist/demo-reset.js --env staging`: the personas forgotten by their hash, the stories told anew through the service functions, the pictures through the pipeline with Rekognition deciding (faces approved, the negatives queued).
3. `node dist/demo-population.js --env staging --photos`.
4. The phone: the `preview` build on channel `staging` (`apps/mobile/README.md`); the tech config screen shows `api.staging.kuutti.app` and the commit. A JS-only merge to `main` reaches it on the next launch; a native change needs the build reinstalled.
5. Aino's three pictures on the phone's camera roll (AirDrop).
6. The admin panel against staging (`ADMIN_APP_URL`, `infra/README.md`), the moderator granted as above, on the bed's identity.

## The morning of

| check | locally | on staging |
|---|---|---|
| the API answers | `curl -s localhost:3000/health` | `curl -s https://api.staging.kuutti.app/health`: the commit is `main`'s |
| the build | the dev client opens Metro | the tech config screen: channel `staging`, the API above, the runtime's fingerprint matches the installed build |
| the counter | `curl -s localhost:3000/waitlist`: Suomi with a total and a split | the same against staging |
| the gate | sign in as Sanna: "Matching is open for you." | the same, through Nordea `DEMOUSER4` |
| the queue | the panel lists Noa's three negatives | the same |
| the refusals | Tapio refused as banned, Ilona with the date | the same, through OP and Aktia |
| the camera roll | the three pictures are there | the same |
| the clock | the gate was counted after the population was written (the reset and the population both count); the nightly count runs at 04:00 Helsinki | the same |

Anything wrong: run the reset again (locally two seconds; on staging under a minute), then the population. A second reset within a minute waits for the rate limit.

## After the demo

- `pnpm demo:reset` locally, the reset in the container on staging: the stories are told anew and Aino is a newcomer again. Her deleted account (scene 7) is inside its waiting time until the reset.
- The recordings stay with the team: they show generated faces, which are private (`photo-prompts.md`); none in a screenshot that leaves the team or in a store listing.
- What the run found wrong is an issue of its own.

## Recording

- Simulator: `xcrun simctl io booted recordVideo --codec h264 demo-local.mp4`, Ctrl-C to stop.
- Phone: the screen recording of the OS; AirDrop the file.
