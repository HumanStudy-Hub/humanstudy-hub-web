# Build Study audit: a pure-human longitudinal experiment

Audit completed 10 October 2026 UTC (9 October in Vancouver).

## Case and actual run

Castelo et al., *Blocking mobile internet on smartphones improves sustained
attention, mental health, and subjective well-being*, PNAS Nexus (2025).
[Original paper](https://doi.org/10.1093/pnasnexus/pgaf017).

This is a human-participant experiment: mobile internet access is blocked for
two weeks, with intervention and delayed-intervention groups observed at three
waves. No AI participant or opponent is part of the published experiment.

[Completed GitHub Actions run](https://github.com/HumanStudy-Hub/HumanStudy-Bench/actions/runs/38026993376).
The run used backend commit `997727cbec9e4f9ad1db78be3dfdf40bc41a29f9` on
`codex/build-study-platform`. It took approximately 22 minutes and returned a
package with status `review`, not an approved or published study.

Inputs were the public paper and its supplementary DOCX. They were staged in
an isolated job, then processed by the original Build Study workflow. No
individual participant dataset was downloaded. The production web adapter,
PDFJS text extraction and actual React components were used to inspect the
returned package locally.

## Findings

| Check | Observed result |
| --- | --- |
| Backend package validation | Passed |
| Canonical schema and exact sidecar agreement | Passed |
| Overview/detail rendering | All 41 nodes and 13 steps represented; all 54 detail views rendered |
| Background and hypothesis | Present |
| Published findings | Present in six analysis nodes, but no separate result nodes |
| PDF quote verification | 7 of 45 paper citations matched the client's page text exactly |
| Supplement citations | Four retained; DOCX text is not indexed by the source viewer |
| Action card descriptions | Eight initially empty; none empty after the projection fix |
| Source inconsistency | Agent surfaced Sunday/Saturday conflicts in the SMS schedule |
| Need input | 12 items; some are replay limitations or informational notes rather than human-study decisions |

The 49 citations are preserved in the canonical program. PDF line-break
hyphenation, punctuation and differing text extraction affect exact matching;
whitespace normalization alone did not recover the unmatched quotes. Remaining
quotes require checking against the original. An agent's claimed `verified`
status is overridden by the web validator when the quote does not match.

The source distinguishes 504 randomized response records and 467 unique
participants after deduplication. The generated participant title conflates
these. Retention and valid-outcome sample sizes also differ, so they must not
be collapsed into a single N. Some fields incorrectly label paraphrased or
combined statements `verbatim`.

The original backend generates an LLM replay package. It cannot reproduce an
actual four-week smartphone intervention or a visual attention task merely by
simulating survey responses. Successful structural validation is not evidence
of scientific fidelity or human-experiment execution readiness.

## Changes following the audit

- Action cards show a bounded procedure summary, falling back to referenced
  actors, inputs and outputs. Canonical scientific data remains unchanged.
- A field with an unmatched PDF citation offers **Review source** to open its
  physical page. It remains unverified and supplies no fabricated rectangle.
  Verified citations are preferred when available. A DOCX pointer is not
  treated as a PDF page.
- The Build Study prompt now separates the original human experiment from
  LLM replay limitations; requests result nodes linked to analyses and outcome
  variables; distinguishes sample counts and field origins; and reserves
  Need input for actionable uncertainties.

The original package is retained unchanged. The revised prompt has regression
coverage but has **not** yet been tested with another live agent extraction.
The current package therefore still contains the extraction problems above.

Validation after the changes: 150 web tests and 47 backend prompt/schema tests
passed, TypeScript and lint checks passed, and the production web build
completed. The local build logged an unavailable GitHub content fetch and used
its existing fallback; this does not confirm live remote content availability.

## Limits and next checks

This validates a real backend run, canonical schema adaptation and server-side
component rendering. It does not validate a logged-in browser journey, source
upload/signing, Supabase persistence, analytics ingestion, email delivery or
deployment access. No participants were recruited or run through an experiment.

Next validation should rerun this case with the revised prompt and check
human-versus-replay separation, actionable questions, reported result nodes,
sample labels and citation fidelity. Supplement viewing/indexing and exact
quote matching need further work. The exported package also contained an
unnecessary Python bytecode file produced during remote smoke validation.

Local audit outputs, including the immutable package and before/after render
reports, are in `/private/tmp/humanstudy-mobile-internet-audit`. These temporary
files are not the application's permanent user storage.
