---
paths:
  - "packages/schema/**"
---

# Shared schema (zod) rules

Consult `https://zod.dev/llms.txt`. This package is the single source of contracts: route inputs and outputs, and the research event registry.

- Every route contract is a zod schema exported from here and used by the API, the mobile app, and the admin panel. No app keeps its own copy.
- Schemas are strict: unknown keys rejected on input, explicit `.max()` on strings and arrays, enums for closed sets, branded ids where confusion is possible (`AccountId`, `PhotoId`, `ResearchId`).
- Response schemas never include like counts (a person's own likes left today aside, #524), exposure counts, desirability metrics, `hetu_hmac`, `research_id`, or another user's `account_id` beyond what the card needs.
- Event registry: one schema per event name. `props` never contain message text, free text from users, email, or raw `seeks`. Every event carries `consent_version`, `pond`, and the coarse snapshot (`age_band`, gender, and the single-choice fields the registry flags `research`, `intent` alone today). k = 10 on every copy that leaves the database; the nightly census warns on a cell under it (ADR-011 §9). Adding an event is a change here with a one-line description of the question it answers.
- Gender counts in any export schema apply the k >= 10 suppression rule.
- Keep this package dependency-free apart from zod; React Native imports it.
