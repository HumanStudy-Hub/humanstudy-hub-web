# Human Program views

Review route: `/build/design?case=mobile&view=flow` (cases: `mobile`, `knobe`,
`knobe-inferred`, `trust`, `game`, `vignette`; views: `flow`, `compare`, `screens`,
`outline`). The route uses the production renderer with local feedback notes. It does not run
an agent or save anything, and it is excluded from search indexing.

This design merges two explorations (`codex/program-visualizations` and
`claude/program-visualizations`). The editor shows four views over the same program. Switching
views never changes the program. Selection, source inspection, comments, agent context and
proposed-change markers keep their callbacks and stable node/field IDs.

| View | Question | Representation |
| --- | --- | --- |
| Flow · Steps | What happens, in what order, by whom, and where do conditions split? | Step cards with their rules, materials and records. Actors become swimlanes, `branch` alternatives run side by side as condition columns, and repeats are containers |
| Flow · Graph | How are the steps connected? | Directed step graph with splits, joins and loops (`programGraph`). Focusing a condition dims the other arms' alternatives |
| Compare | What actually differs between conditions, or between studies? | Aligned rows per arm. Identical rows collapse, and differing words are marked |
| Screens | What does one participant see? | Screen by screen for one condition, from `verbatim` fields and transcribed questions only. Unreported details appear as amber gaps |
| Outline | The earlier card overview | unchanged |

## Reducing what the reader holds in mind

- One tab row for the view and one for the study scope. Each condition keeps the same colour in
  every view.
- Background, design and data nodes are collapsed into counted groups (Codex). Steps with more
  than four records collapse them.
- A click selects. Details opens the inspector, and Ask agent sends the selection to the
  conversation (Codex). Open questions show as amber marks where they apply.
- Empty states offer one agent action ("map the flow", "check conditions") instead of a blank
  panel.

## Scientific boundaries

- Connections come from `steps[].next` and typed containment. Array order, title similarity and
  field prose never create arrows.
- Conditions come, in order, from the agent's `extensions.presentation`, from `branch` steps, or
  as a fallback from a design or manipulation field that lists condition labels. The fallback is
  labelled "inferred · confirm", and that label asks the agent to check the conditions.
- A later branch joins the arms only when each alternative carries exactly one arm's label (a
  crossover's "Intervention arm: …" in both phases). Otherwise it stays unmapped. Compare marks
  it as differing, never as identical, and Screens shows a gap. Reachability alone is not taken
  to mean both arms run the same later steps.
- A manipulation check is an outcome. It never marks the point where the conditions split.
- When no conditions exist, studies are compared as studies, never relabelled as conditions.
- Screens and Compare display field values only. Text clipped for a diagram label stays in its
  accessible name, tooltip and details.

## `extensions.presentation` (written by the build agent)

The views work without this block. Conditions come, in order of preference, from this block,
from `branch` steps (each alternative is an arm; a later branch, such as a crossover's second
phase, joins the arms only when every alternative carries exactly one arm's label before the
colon), or from a design or manipulation field that lists condition labels, and screens are inferred from each step's visible inputs.
That inference is fragile, though. In the Knobe sample it puts the vignette and both questions
on one screen. The build agent already reads the paper, so it can state the presentation
directly:

```json
"presentation": {
  "conditions": [
    {"id": "harm", "label": "Harm", "studyIds": ["exp-1", "exp-2"], "nodeIds": ["material-1-harm", "material-2-harm"]},
    {"id": "help", "label": "Help", "studyIds": ["exp-1", "exp-2"], "nodeIds": ["material-1-help", "material-2-help"]}
  ],
  "screens": [
    {"stepId": "exp-1-read",   "blocks": [{"field": "vignette"}]},
    {"stepId": "exp-1-answer", "blocks": [{"field": "questions", "item": 0}, {"field": "questions", "item": 1}]}
  ]
}
```

- `conditions[].nodeIds` lists the condition-specific nodes. Colours, lanes, the Compare
  columns and the Screens condition switch all come from this list.
- A screen block refers to a field and never carries text. A block without `node` resolves
  against the nodes visible in that step for the selected condition, so one spec serves every
  condition. `item` picks one element of an array field. `{"gap": "<issue id>"}` places an
  open question on the screen.
- Unknown node, step and issue IDs are ignored, so a stale block can't break rendering.

The Knobe sample (`data/studio-samples/intentional-action/program.json`) carries this block.
On the review route, "Side effects · inferred only" is the same program without it, so the two can be
compared directly.

A future change to the HumanStudy-Bench agent prompt (`agent_pipeline/CLAUDE.md`) should ask
the agent to write this block. It is not part of this branch.

## Cases

See `components/studio/design-cases/README.md` for provenance. The side-effects cases use
`data/studio-samples/intentional-action/program.json`.
