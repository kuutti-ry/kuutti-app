# The research copy

For the association's research partner: what the files under `research/` hold and how to read them. The decision behind it is [ADR-029](../adr/029-the-research-copy.md); the events themselves, what each one answers and what it carries, are the registry `RESEARCH_EVENTS` in `packages/schema/src/research.ts` and [ADR-011](../adr/011-research-events.md).

Access is a read-only role on `research/` of one environment's bucket and nothing else, and every read is logged (ADR-029 §10 and §11). The maintainer hands it over, staging first, whose people are invented (ADR-018). Production has no copy yet: it waits on the points ADR-029 leaves to him, the wording of the research consent first.

## What is there

One file per UTC day, `research/YYYY/MM/YYYY-MM-DD.parquet`, written the night after the day ends and never rewritten. A day without events is a file with the whole schema and no rows; a day without a file is a night the copy missed, written on a later night while the database still holds the day (ninety days at most). After twelve months a file moves to Glacier Instant Retrieval: still read the same way, at a higher price per read.

One row is one event of a person who had given the research consent at the time:

| Column | Type | What |
|---|---|---|
| `at` | timestamp, UTC, milliseconds | the hour of the event; never finer |
| `name` | string | the event, a name of the registry |
| `research_id` | string | the pseudonym: the same person while they stay in the study, a new one if they withdraw and join again; it names nobody, and the association removes its link to the person on withdrawal or erasure |
| `consent_version` | string | the wording of the research consent the person had accepted |
| `pond` | string or null | where the person looks for others; null: not chosen yet; `*`: withheld |
| `age_band` | string | `18-24`, `25-29`, `30-34`, `35-39`, `40-49`, `50+`; or `18-29`, `30-39`, `40+` when coarsened |
| `gender` | string or null | self-declared: `woman`, `man`, `non_binary`; null: not declared |
| `field_intent` | string or null | what the person is here for; null: not answered; `*`: withheld. A further profile field joins as a column `field_<key>` from the day it is flagged |
| `props` | JSON | the event's own values, as the registry defines them: numbers, true or false, a closed list; never text |

## What is withheld, and why

A combination of `pond`, `age_band`, `gender` and the `field_` columns is released only when at least ten people carry exactly that combination, counting this file and the files of the previous ninety days: ten different `research_id` whose research consent was still live on the night the file was written. A person has one live `research_id` at a time, and one that has withdrawn since counts for nobody, so a later file can withhold a combination an earlier file released. Under ten, the fields become `*`, then the age band is coarsened, then the pond becomes `*`; an event still under ten is left out. So `*` means "withheld for anonymity", never "unknown", and a coarse band is a band, not an error. Each file's metadata says k (`kuutti.k`), the rule (`kuutti.census`) and how many events it left out (`kuutti.dropped`) or could no longer read (`kuutti.unreadable`).

Treat the copy as anonymised data under the agreement with the association: no attempt to find out who a `research_id` is, and nothing joined to it from outside the copy.

## Reading it

Copy the files down with the profile the maintainer gives you, then read the folder:

```sh
aws s3 sync s3://<bucket>/research/ ./research/ --profile kuutti-research
```

DuckDB (`union_by_name` admits files written before a field column was added):

```sql
SELECT name, date_trunc('week', at) AS week, count(DISTINCT research_id) AS people
FROM read_parquet('research/*/*/*.parquet', union_by_name = true)
GROUP BY ALL ORDER BY week;

SELECT props->>'approvedPhotos' AS photos, count(*)
FROM read_parquet('research/*/*/*.parquet', union_by_name = true)
WHERE name = 'profile_saved' GROUP BY ALL;
```

pandas with pyarrow:

```python
import json
from pathlib import Path
import pandas as pd

files = sorted(Path("research").rglob("*.parquet"))
events = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
events["props"] = events["props"].map(json.loads)  # a JSON string per row
```

`at` reads as a UTC timestamp (`datetime64[ms, UTC]` in pandas). The files are written by `hyparquet-writer` and checked in the API's tests with its companion reader; the snippets above wait for their first run against a staging file before the handover (ADR-029 §7).
