# Human Program visualization review

Branch: `codex/program-visualizations`.
Review route: `/build/design?case=mobile&view=flow`.

The existing editor uses the same three renderer modes. Selection, source
inspection, comments, agent context and proposed-change markers retain their
existing callbacks and stable node/field IDs. Switching views never changes
the canonical program. Main-editor view/path/contrast controls carry event IDs
for the existing interaction collector.

| View | Main question | Representation |
| --- | --- | --- |
| Flow | How does the experiment run? | Directed step graph with splits, joins, repeated operations and explicit input/output counts |
| Paths | What happens in this alternative? | The same graph; a selected branch stays prominent, other alternatives stay visible |
| Compare | What differs between alternatives? | Alternative paths side by side; their shared start and continuation appear once |

Background, design/resources and data/findings are collapsed by default. A
node click selects it; Details opens the inspector; Ask agent sends the same
selection to the existing conversation. This avoids opening a large inspector
on every click or repeating an agent composer inside the program panel.

## Scientific boundaries

- Connections come from `steps[].next` and typed branch/containment references.
  Node array proximity, title similarity and field prose never create arrows
  or experimental condition assignments.
- Sequence wrappers without outgoing/incoming transitions are shown as
  inspectable group labels rather than drawing a fan of containment edges.
- Repetition/parallel containment is visually distinct from a next-step arrow.
  Strongly connected components keep feedback-loop layout finite.
- Branch comparison uses referenced branch alternatives and graph reachability.
  The visual layout is not interpreted as timing or duration.
- When no branches exist, empirical study scopes can be compared as studies;
  they are not silently reclassified as conditions. Missing flow/condition
  mappings are explicit and can be discussed with the real agent.
- All nodes, including custom kinds, remain inspectable. Text clipped for a
  diagram label remains available in its accessible name, tooltip and details.

## Review examples and scope

The public design review includes the actual 2025 mobile-internet audit output,
trust-game interactions, repeated guessing-game rounds and an unmapped vignette
protocol. See `components/studio/design-cases/README.md` for provenance.

The review route uses local feedback notes instead of pretending to run an
agent. It does not create a workspace or collect private materials. It does
not index attached PDFs, so claimed quote-verification flags are demoted for
this isolated view. The real editor continues using its actual sources and
backend. The review route is excluded from search indexing.

This branch does not change authentication, database schemas, pipeline
prompts, domain assignments or the production deployment. View preference is
currently presentation state, not a persisted scientific or workspace change.

Validation: 156 studio tests, TypeScript and changed-file lint checks. The
production web build also includes the new review route. Tests cover the
actual split/join case, unique anchor coverage, shared-path deduplication,
feedback loops, scope isolation, custom kinds and missing flow mappings.
