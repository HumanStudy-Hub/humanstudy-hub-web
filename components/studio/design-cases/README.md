# Public design-review cases

These immutable examples exercise the same Human Program renderer as the live
study editor. They contain no user accounts, private uploads or chat histories.

- `mobile-internet.json`: unmodified canonical program returned by the actual
  [Build Study audit run](https://github.com/HumanStudy-Hub/HumanStudy-Bench/actions/runs/38026993376)
  for Castelo et al. (2025), [PNAS Nexus](https://doi.org/10.1093/pnasnexus/pgaf017).
  The article is open access under CC BY. Preserve author attribution. The
  agent's extraction has known scientific/citation issues documented in
  `docs/validation/mobile-internet-2025.md`; it is not an approved study.
- `study_009.json`, `study_012.json`, `study_005.json`: exact programs from the
  existing schema compatibility fixtures (`tests/fixtures/human-program-v2.json`).

The review route is `/build/design` on the visualization development branch.
Its notes are held in tab memory; it does not send messages to an agent or save
a user's study. The real editor retains its existing API, persistence and agent
integration. View switching changes presentation, never the program.
