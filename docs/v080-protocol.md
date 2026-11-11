# v0.8 protocols on the web

Web part of the v0.8 platform design (PRs W1–W3). Everything is additive: papers without a
`protocol` block and runs without `kind` behave exactly as before.

## W1: catalog field and study page

- `lib/research.ts`: `ResearchPaper.protocol` (written by Bench `catalog.py`, PR B3) and
  `readProtocol(paper)`, a tolerant reader. Unknown fields are ignored, malformed fields are
  dropped. `schemaVersion` `"1"` (protocol v1, the engine schema Bench writes) is known and
  runnable; legacy `"0.8"` entries are still read but not runnable; anything else is shown
  with a note ("newer than this site reads"). It returns `null` when there is no usable block.
- Fields read: `slug` (hsenv id shape `^[a-z0-9][a-z0-9_-]*$`, at most 80), `schemaVersion`,
  `hsenv`, `fidelity {verdict, signedBy|signed_by}` (verdict normalised: `high_fidelity` and
  `HIGH FIDELITY` both read as `high fidelity`), `arms [{id, label?, runnable, nPaper}]` (the page
  shows `label`, else the id with underscores as spaces), `runExcluded [string | {what, reason}]`, `effects`,
  `revision`, and `preview` + `previewPublic` (or `preview_public`).
- `preview` (participant view, screen by screen per arm) is **not yet in the B3 field list**.
  Protocols are private by policy, so the page links it only when the entry also carries
  `previewPublic: true` (literal boolean) and the URL is `https`. Without the flag there is no
  link. **Bench side (not changed here):** if B3 ever publishes a preview, it must write
  `preview` together with `previewPublic: true`; a bare `preview` is ignored. Where previews
  are hosted is still open (the release allowlist has no `preview/`).
- Study pages show protocol conditions, effects and exclusions. Review wording and the
  **Validated protocol** badge require catalog-level provenance for the exact current revision,
  in addition to the signed fidelity verdict and runnable scope.
- The optional catalog-level `publications` object maps a paper ID to
  `{ "kind": "user-submitted" | "maintainer-reviewed-protocol", "revision": "<64 hex>" }`.
  Bench should populate it from its controlled publication process. Keep contributor-authored
  metadata inside paper records, where it cannot set publication provenance. Missing or stale
  provenance leaves the quality badge hidden. `user-submitted` displays **User submitted**.
- `getCommunityPapers` / `COMMUNITY_INDEX_BRANCH` are removed. `/api/community/paper`
  answers from `research_index.json` only.

## W2: protocol runs (`PROTOCOL_RUNS_ENABLED=1`, off by default)

`lib/playground-runs.ts` writes run.json `kind: "protocol"` when the request has
`kind: "protocol"` or the study id is a `paper_` id:

```
"kind": "protocol",
"study": {"store": "bench", "path": "community/paper_x/revisions/<sha256>", "commit": "<40 hex>"},
"rendering": "screen" | "screen+seen" | "chat",
"n": "paper" | int, "seeds": [..], "arms": [..] | null, "maxRetries": 2
```

- The pin is resolved at create time: the Bench `main` commit, then
  `community/<paper>/current.json` at that commit gives the revision.
- `validateProtocolOptions` checks options against the catalog summary: only runnable arms,
  n capped by the shared or own-key limit, at most 5 seeds, and protocol v1 (`schemaVersion` "1").
- `studyId`, `model`, `preset`/`systemPrompt` and `personaGroup` are unchanged. The cache
  matches on the pin and options too. Workflow inputs (`run_id`, `jobs_repo`) are unchanged.
- The API route passes `kind, store, rendering, n, seeds, arms` through. The playground page is
  hidden today, so there is no UI for this. The agent or API calls it.
- **Turn the flag on only after Bench B4 is merged.** Before that, the runner does not know
  `kind` and would treat the run as a legacy study.

## W3 groundwork: private store (`PRIVATE_PROTOCOLS_ENABLED=1` + token, off by default)

`lib/protocols.ts` is server-only (`import "server-only"`). The store is named only by
`HUMANSTUDY_PROTOCOLS_REPO` (no default; the name is not written in this public repo). It reads the private store's `index.json` through the
GitHub API and projects each entry to metadata (slug, title, authors, year, fidelity, arms).
Everything else is dropped, and a test checks this with a canary string.
`resolvePrivateProtocol(slug)` pins `{store: "protocols", path: "studies/<slug>", commit}` for
a run with `store: "protocols"`. Nothing lists private studies in the UI yet.

## Blocked

| Item | Waits on |
|---|---|
| Real `protocol` data on the page | B3 (catalog writes the block) |
| `preview` field | owner/B3: whether and where participant-view previews are published; Bench must add `previewPublic: true` with it |
| Turning on `PROTOCOL_RUNS_ENABLED` | B4 merged (run_protocol.py, hsenv pin in run-playground.yml) |
| W3 listing + `PRIVATE_PROTOCOLS_ENABLED` | P1 (store layout, `index.json` shape from build_index.py), G3 leak test, owner rule for "allowed" users, token |

## Tests

`tests/research-protocol.test.mjs`, `tests/playground-protocol.test.mjs`, with made-up data in
`tests/fixtures/research-protocol.json`. `tests/fixtures/research-index-protocol.json` is a byte-identical copy
of the Bench shared fixture `tests/fixtures/protocol_release/research-index-protocol.json` (the block B3
writes; see `tests/fixtures/README.md`) (no real study, paper or protocol text: this repo is
public).
