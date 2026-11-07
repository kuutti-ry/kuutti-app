# The demo-day runbook

How a demo is prepared and checked, locally and on staging (#144). The story itself is `storyboard.md`; the people, `services/mock-idp/README.md`; the population, `population.md`; the pictures, `photo-prompts.md`. Dates are d.M.yyyy; times Helsinki.

## The evening before

### Locally (the simulator, the mock bank)

1. `pnpm env:up`: the database, the S3 stand-in, the mock bank, the API, Metro.
2. `pnpm demo:assets`: the release of pictures into `~/.cache/kuutti-demo-photos/v4`, verified. Without it nobody has a photo and the storyboard's photo scenes do not work.
3. `pnpm demo:population -- --photos`: three hundred people in the one pond, each with a home somewhere in Finland (`population.md`), with faces of the pool by seed, and the cast (`population.md`), who are why this comes before the reset; the counter counted anew and the ponds opened.
4. `pnpm demo:reset`: everybody forgotten through the erasure path, then the nineteen stories through the API's own routes, with their pictures (Sanna 5, Noa 2 + the queue's 4, Kerttu 4, and the round's cast: Iida 3, Henna, Katja, Minna and Riikka 2 each, from release v3; the faces approved locally but Noa's second, the negatives queued), the stories' conversations, then the population's consents brought to the wordings in force (a new version leaves nobody of it off the cards, ADR-014 §12), the counter counted and the ponds opened, then Iida's day (#379). A card nobody displayed is new again the next day, so scene 5 holds from this reset; a rehearsal of it is reset again (below).
5. Aino's camera roll: `xcrun simctl addmedia booted ~/.cache/kuutti-demo-photos/v4/faces/aino/*.jpg` (the simulator must be booted). On a device, AirDrop the five files.
6. `pnpm dev:mobile` and open the dev client on the simulator; the tech config screen (the wrench on the home screen) shows the API it talks to.
7. The admin panel: `pnpm dev:admin` at `http://localhost:5173`; the moderator is a persona that was given the role after its first login: `pnpm --filter @kuutti/db moderator -- grant <hetu_hmac> moderator --by "<your name>"`, the hash from the API's log line of that login (`infra/README.md`, Staff). Use Mikael: a moderator persona is spared by the reset, so never one with a story.

### On staging (the phone, Telia's test banks)

Staging holds no real person (ADR-018). The three commands run inside the API's container and nowhere else; `infra/README.md`, "The demo on staging", says how to reach it. In order:

1. `node dist/demo-assets.js` in the container, and again after every deploy: the cache is the container's own and a new container starts without it, so the stories, the population and the reset refuse until it is there. The release's tarball comes from the public repository over HTTPS into the cache, checked against the manifest; the job refuses a cache that is not the release's.
2. `node dist/demo-population.js --env staging --photos`: the people, and the cast (`population.md`), whose likes and chats the reset gives the members.
3. `node dist/demo-reset.js --env staging`: the personas forgotten by their hash, the stories told anew through the service functions, the pictures through the pipeline with Rekognition deciding (faces approved; the pictures without a face and the group picture rejected with their reasons, nothing queued). Steps 1 and 3 together are the `Demo reset` workflow on GitHub, which runs them every night at 02:17 (#560) and whenever it is started (`gh workflow run demo-reset.yml`, from `main`; #613, ADR-018 §8): how the reviewers' and the testers' accounts hold their likes, fish and chats every morning, and how a round of testing starts clean without a terminal on the box. The night undoes what anybody did on the personas that day. It leaves step 2's people as they are, so the members get their likes and chats again from the cast already written. A red run means the reset's last line names a persona it spared.
4. The phone: the `preview` build on channel `staging` (`apps/mobile/README.md`); the tech config screen shows `api.staging.kuutti.app` and the commit. A JS-only merge to `main` reaches it on the next launch; a native change needs the build reinstalled.
5. Aino's five pictures on the phone's camera roll (AirDrop).
6. The admin panel at `https://admin.staging.kuutti.app` (`infra/README.md`, Admin panel), the moderator granted as above, on the bed's identity, a test person outside the twenty-five personas: a persona with a staff role or a line in the audit log is spared by every later reset (ADR-014 §12), and its audit lines stay until the database is made anew. A panel on the laptop cannot finish a staging login: the bank sends it back to the hosted panel.

A later write of the population takes the cast's likes and chats with it, so the reset runs again after one. Steps 2 and 3 are also what give staging its homes after a deploy that brought them (ADR-061). A persona whose story was given before is resumed and never retold, so `node dist/demo-stories.js` alone leaves it without one, and the population of an older deploy has none either: they stay active, read as having no home and are in nobody's pool, and no error says so.

## The morning of

Locally, `pnpm demo:reset` again if anybody went through scene 5 since the last one: a card looked at on an earlier day comes back labelled "Seen before", and a decision holds (`storyboard.md`). The reset leaves the population and the camera roll as they are; with Mikael the moderator (step 7), it names him as spared and exits with an error, after doing the rest. On staging the night's run at 02:17 did it; run the workflow again if anybody went through a member's People since.

| check | locally | on staging |
|---|---|---|
| the API answers | `curl -s localhost:3000/health` | `curl -s https://api.staging.kuutti.app/health`: the commit is `main`'s |
| the build | the dev client opens Metro | the tech config screen: channel `staging`, the API above, the runtime's fingerprint matches the installed build |
| the counter | `curl -s localhost:3000/ponds/counter`: Suomi with its number, `finished` | the same against staging |
| matching | sign in as Sanna: "Matching is open for you." | the same, through Nordea `DEMOUSER4` |
| the queue | sign in as Iida, See people: Henna first, "Liked you" and Nearby, and three more nearest first, Katja Close, Minna Around and Riikka Far (with a population whose pool has faces, which v2 does not give, women of it may come among them, in the order of their bands); look, decide nothing (a decision stands until midnight, and a match or a report for good). "Seen before" on a card, or fewer people: somebody went through it on an earlier day, so reset again. No See people on home: the reset did not reach the day; read its log (a cache of a release older than v3 stops it at Iida, step 2) | none: scene 5 runs locally only |
| the queue | the panel lists Noa's four negatives and her second face | empty: the check decides Noa's pictures itself (her faces and the EXIF one approved, the landscape, the text and the group picture rejected with their reasons) |
| the members' people | with the cast written, as Sanna, See people: Jere first, "Fish", then Risto and Karim, "Liked you", and her chats with Juha and Mika; decide nothing | the same, through Nordea `DEMOUSER4` |
| the refusals | Tapio refused as banned, Ilona with the date | the same, through OP and Aktia |
| the camera roll | the five pictures are there | the same |
| the clock | the counter was counted after the population was written (the reset and the population both count, and both open the ponds); the nightly count runs at 04:00 Helsinki | the same |

Anything wrong: run the reset again (locally two seconds; on staging under a minute), then the population. Locally, a second reset within the minute of the first waits, up to a minute: a reset spends twenty of the sixty sign-in starts a minute development allows (one per history, all nineteen of which log in, and one that asks the API which database it serves), and some seventy of the 120 requests a minute of its address, since what no session guard admits stays the address's (the starts, the bank's returns, the exchanges, the logouts and Ilona's deletion; ADR-026 §2 and §4). So the address's window is the one a second reset meets; the starts' window alone would first stop a fourth reset in the same minute. On staging the reset calls no route and waits for nothing. A reset that refused after "personas forgotten" (a missing cache, say) has erased the personas and told nobody: fix the cause and run it again, and it tells the stories from nothing.

## After the demo

- `pnpm demo:reset` locally, and on staging the workflow, or the night's run: the stories are told anew and Aino is a newcomer again. Her deleted account (scene 8) is inside its waiting time until the reset; and Iida's queue (scene 5), once decided, is hers again only after it.
- The recordings stay with the team: they show generated faces, which are private (`photo-prompts.md`); none in a screenshot that leaves the team or in a store listing.
- What the run found wrong is an issue of its own.

## Recording

- Simulator: `xcrun simctl io booted recordVideo --codec h264 demo-local.mp4`, Ctrl-C to stop.
- Phone: the screen recording of the OS; AirDrop the file.
