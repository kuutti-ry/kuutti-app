# The demo-day runbook

How a demo is prepared and checked, locally and on staging (#144). The story itself is `storyboard.md`; the people, `services/mock-idp/README.md`; the population, `population.md`; the pictures, `photo-prompts.md`. Dates are d.M.yyyy; times Helsinki.

## The evening before

### Locally (the simulator, the mock bank)

1. `pnpm env:up`: the database, the S3 stand-in, the mock bank, the API, Metro.
2. `pnpm demo:assets`: the release of pictures into `~/.cache/kuutti-demo-photos/v2`, verified. Without it nobody has a photo and the storyboard's photo scenes do not work.
3. `pnpm demo:reset`: everybody forgotten through the erasure path, then the six stories through the API's own routes, with their pictures (Sanna 5, Noa 2 + the queue's 4, Kerttu 4; the faces approved locally but Noa's second, the negatives queued), then the counter and the gates counted.
4. `pnpm demo:population -- --photos`: three hundred people in the one pond, with faces of the pool by seed; the counter and the gates counted anew.
5. Aino's camera roll: `xcrun simctl addmedia booted ~/.cache/kuutti-demo-photos/v2/faces/aino/*.jpg` (the simulator must be booted). On a device, AirDrop the five files.
6. `pnpm dev:mobile` and open the dev client on the simulator; the tech config screen (the wrench on the home screen) shows the API it talks to.
7. The admin panel: `pnpm dev:admin` at `http://localhost:5173`; the moderator is a persona that was given the role after its first login: `pnpm --filter @kuutti/db moderator -- grant <hetu_hmac> moderator --by "<your name>"`, the hash from the API's log line of that login (`infra/README.md`, Staff). Use Mikael: a moderator persona is spared by the reset, so never one with a story.

### On staging (the phone, Telia's test banks)

Staging holds no real person (ADR-018). The three commands run inside the API's container and nowhere else; `infra/README.md`, "The demo on staging", says how to reach it. In order:

1. `node dist/demo-assets.js` in the container, and again after every deploy: the cache is the container's own and a new container starts without it, so the stories, the population and the reset refuse until it is there. The release's tarball comes from the public repository over HTTPS into the cache, checked against the manifest; the job refuses a cache that is not the release's.
2. `node dist/demo-reset.js --env staging`: the personas forgotten by their hash, the stories told anew through the service functions, the pictures through the pipeline with Rekognition deciding (faces approved; the pictures without a face and the group picture rejected with their reasons, nothing queued).
3. `node dist/demo-population.js --env staging --photos`.
4. The phone: the `preview` build on channel `staging` (`apps/mobile/README.md`); the tech config screen shows `api.staging.kuutti.app` and the commit. A JS-only merge to `main` reaches it on the next launch; a native change needs the build reinstalled.
5. Aino's five pictures on the phone's camera roll (AirDrop).
6. The admin panel at `https://admin.staging.kuutti.app` (`infra/README.md`, Admin panel), the moderator granted as above, on the bed's identity. A panel on the laptop cannot finish a staging login: the bank sends it back to the hosted panel.

## The morning of

| check | locally | on staging |
|---|---|---|
| the API answers | `curl -s localhost:3000/health` | `curl -s https://api.staging.kuutti.app/health`: the commit is `main`'s |
| the build | the dev client opens Metro | the tech config screen: channel `staging`, the API above, the runtime's fingerprint matches the installed build |
| the counter | `curl -s localhost:3000/waitlist`: Pääkaupunkiseutu with a total and a split | the same against staging |
| the gate | sign in as Sanna: "Matching is open for you." | the same, through Nordea `DEMOUSER4` |
| the queue | the panel lists Noa's four negatives and her second face | empty: the check decides Noa's pictures itself (her faces and the EXIF one approved, the landscape, the text and the group picture rejected with their reasons) |
| the refusals | Tapio refused as banned, Ilona with the date | the same, through OP and Aktia |
| the camera roll | the five pictures are there | the same |
| the clock | the gate was counted after the population was written (the reset and the population both count); the nightly count runs at 04:00 Helsinki | the same |

Anything wrong: run the reset again (locally two seconds; on staging under a minute), then the population. Locally, resets in quick succession wait for the sign-in window, up to a minute: a reset spends some eight of the sixty sign-in starts a minute development allows (ADR-026), so about the eighth in one minute waits; on staging the reset calls no route and waits for nothing. A reset that refused after "personas forgotten" (a missing cache, say) has erased the personas and told nobody: fix the cause and run it again, and it tells the stories from nothing.

## After the demo

- `pnpm demo:reset` locally, the reset in the container on staging: the stories are told anew and Aino is a newcomer again. Her deleted account (scene 8) is inside its waiting time until the reset; and Iida's round (scene 5), once decided, is hers again only after it.
- The recordings stay with the team: they show generated faces, which are private (`photo-prompts.md`); none in a screenshot that leaves the team or in a store listing.
- What the run found wrong is an issue of its own.

## Recording

- Simulator: `xcrun simctl io booted recordVideo --codec h264 demo-local.mp4`, Ctrl-C to stop.
- Phone: the screen recording of the OS; AirDrop the file.
