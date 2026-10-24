# Architecture

How Kuutti is built and where it runs, from the system's side: which apps and services exist, what talks to what, what runs on which machine, how a change reaches them, and the steps of the bank login, a photo upload, a chat message and the night's jobs. It is written for a contributor or a reviewer who wants to see the whole before reading the code. The person's side of the same journeys is drawn in #395 (`docs/flows/`, once it lands); the reasons are the ADRs in `docs/adr/`, and each view names the ones it draws.

## The views

| View | What it draws | Its ADRs, among others |
|---|---|---|
| [1. Context](context.md) | The people who use Kuutti, the outside services it depends on, and what travels between them | ADR-001, ADR-016, ADR-025, ADR-029, ADR-043 |
| [2. Components](components.md) | The three apps, the packages, the Telia kit and the mock bank; inside the API's one process; the ten slices and which app holds which; the import boundary | ADR-003, ADR-017 §6, ADR-031 §9 |
| [3. Deployment](deployment.md) | A developer's machine, staging and the services around its box, a pull request's previews, production as composed, the website | ADR-001, ADR-005, ADR-012, ADR-025 |
| [4. Delivery](delivery.md) | What a pull request, a merge and a release tag set off, workflow by workflow, and what each job may touch | ADR-004, ADR-012, ADR-028 |
| 5. Sequences: [the bank login](sequence-login.md), [the photo upload](sequence-upload.md), [chat](sequence-chat.md), [the night's jobs](sequence-night.md) | Step by step, between the app, the API, the database and the outside services | ADR-016, ADR-027; ADR-005, ADR-006; ADR-031; ADR-029, ADR-035 |
| [6. Data and trust boundaries](trust.md) | Where a person's data lives and what crosses each boundary: the hetu, the secrets, photos, research events, logs; the security checklist's four surfaces | ADR-001, ADR-008, ADR-011, ADR-027 |

## How a view is drawn

**What is drawn.** What is deployed: the code, `infra/` and the workflows on `main`. What is planned is drawn dashed, and its label says "not built yet" or "planned" with its issue: push (#102), CloudFront-only ingress (#198), production's apply (#25), further mail (#196), signed updates (ADR-004 §4). What waits on a step outside the repository says so: the SES identity of `infra/bootstrap` (#385), which the maintainer applies. What is open is labelled open, since both questions are the maintainer's (CLAUDE.md, Decisions): the box's deploy tool is "Dokploy (current; Kamal open)", and #86's app attestation and iOS screenshot detection are undecided.

**Where two sources disagree**, the code and its ADR, rule or README, the step is drawn neither way, or as the code with the other named, and the file's Open says which.

**Nothing beyond the public infra code**: no IP address, no AWS account id, no secret's value. Parameters and secrets appear by name, as `infra/` names them.

**The diagrams** are Mermaid, which GitHub draws in the Markdown itself, so they are text, reviewed in a pull request like code. The conventions are those #395's user flows use (`docs/flows/README.md`, once it lands):

- Context, components, deployment, delivery and trust are `flowchart`s, with one `subgraph` per place or owner.
- The sequences are `sequenceDiagram`s with `autonumber`.
- A flowchart's labels are in double quotes, so punctuation cannot break them. A sequence's are not, since it would show the quotes. There, an issue's `#` is written `#35;` (drawn as `#`), and no label holds a semicolon, because a bare `#` or `;` ends a label.
- No colours, fills or styles. A dashed outline (`classDef notbuilt stroke-dasharray: 5 5`) or a dotted arrow marks what is not built, and the label says so as well.
- Every diagram opens with `accTitle` and `accDescr`, which GitHub hands to screen readers.
- A diagram has at most about twenty boxes; a larger view is split into parts.

**The steps.** Under each diagram, the same view as numbered steps: one per box in a flowchart, and one per numbered arrow in a sequence. The diagram is checked against them, and a screen reader reads them. Each file ends with "Where it lives" (the paths, workflows, ADRs and issues it draws) and "Open".

## Keeping them true

A change to what a view draws redraws it, and its steps, in the same pull request: a module, an environment, a workflow's step or rights, an outside service, a flow across the system, a trust boundary. Something planned stays dashed until the change that lands it redraws it.

Each view names the files it draws in a `<!-- draws` block under its title, one path per line, a trailing `/` for a folder: the files whose change would change the drawing, not the whole of its "Where it lives". A pull request that touches one of them touches the view too, or says in a commit message that the view is still true:

```
Still-true: docs/architecture/sequence-chat.md (the send's limiter only)
```

`pnpm check:docs` (in CI's `scenarios` job) fails otherwise, and on a block naming a file that is gone: a rename or a removal is redrawn with its block (ADR-047). It cannot see whether a drawing is right; review does.

The views were checked against `main` at `ea372faa` on 2026-10-24, every fact by its path and line, and every diagram drawn with Mermaid 11.
