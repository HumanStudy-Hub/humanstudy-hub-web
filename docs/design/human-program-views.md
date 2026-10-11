# Human Program panel

Review route: `/build/design?case=mobile` (cases: `mobile`, `knobe`, `knobe-unstated`, `trust`,
`game`, `vignette`). The route uses the production renderer with local notes. It runs no agent,
saves nothing, and is excluded from search indexing. Without the PDF, "Select a passage" lists the
program's cited quotes so reverse tracing can be tried.

The acceptance test for this panel: with a new paper, can a researcher quickly understand how the
experiment runs and find where each key statement comes from?

## One flow that adapts to the experiment

The panel has no view tabs. It shows one flow, and the flow's shape follows the program's
structure:

| Program structure | What appears |
| --- | --- |
| Steps joined by `next` | One line with arrows |
| Steps with no `next` between them | "order not stated" instead of an arrow |
| `branch` / `parallel` | Children side by side; the shared continuation follows once below |
| `repeat` | A container marked "↻ repeats" with its rule |
| Two or more actors | Swimlanes, one column per actor |
| `next` to an earlier or non-adjacent step | Written out in the step ("↩ back to …", "→ continues to …"), never drawn as the next arrow |
| Condition nodes with `conditionIds` | One colour per condition; focusing a condition dims other paths |

Steps start as one-line rows. Clicking a row selects it and opens it in place:
- its rule;
- what the participant sees (`visibleIds`), kept separate from what the step only uses
  (`inputIds`);
- its records (folded when there are more than four).

Condition-specific materials sit side by side with the differing words marked, so a manipulation
is checked where it happens in the flow. Background, design and data nodes stay folded in counted
groups.

## Original source, both ways

- Every step, node and field carries its citation: `p. N` opens the paper at the quote, and `file`
  marks a material file. A dashed `p. N?` is a citation not yet matched on the page. Items with no
  citation show "no source", so they never read as settled facts.
- When the source panel is open, selecting a program item turns to its passage. The selection bar
  also offers "Source · p. N".
- Selecting text in the paper highlights the program items whose evidence quotes it: same source
  and page, and a run of shared words long enough to be the same sentence. A bar names those items,
  or says that nothing cites the passage.
- Field origins other than `verbatim`/`reported` are labelled: implementation choice, derived,
  researcher, origin unknown.

## Scientific semantics

- Arrows come only from `steps[].next`. Array order and nesting are not execution order.
- Conditions are formal: nodes of kind `condition`, joined by `conditionIds` on steps and nodes.
  Steps in different phases that share a condition id run in the same condition. That is how a
  crossover is stated, never by matching titles. Validation rejects `conditionIds` that name a
  node of another kind or from another study.
- When no conditions are stated, the panel offers a suggestion (branch titles or a design field
  listing levels) with "Confirm with agent". The suggestion never colours, groups or aligns
  anything.
- Comparison is structural. Branch alternatives are columns of their own subtrees, so paths of
  different length do not shift the steps that follow.

## `extensions.presentation` (presentation plan, written by the build agent)

```json
"presentation": { "open": ["exp-1-read"], "collapsed": ["practice-rounds"] }
```

- `open` lists step ids shown opened first: the stages a reader should see before anything else.
- `collapsed` lists container step ids that start folded.

The plan arranges the program only. Order, conditions and every other scientific relation come
from the program itself. Unknown ids are ignored.

## Cases

See `components/studio/design-cases/README.md` for provenance. The side-effects cases use
`data/studio-samples/intentional-action/program.json`. In that sample, Harm and Help are
condition nodes; `knobe-unstated` is the same program with them removed.
