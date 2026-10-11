# Human Program views

The Human Program panel has four views over the same program. Open `/build-preview/views`
to compare them on real programs without signing in. Nothing is saved there.

| View | Question it answers | Built from |
|---|---|---|
| Flow | In what order do things happen, who does each step, and where do conditions split? | `steps` (order from `next`, nesting from `children`), actors as swimlanes, `branch` alternatives as side-by-side arm columns, condition materials as coloured lanes |
| Compare | What actually differs between conditions (or between studies)? | Aligned rows per arm. Identical rows collapse and differing words are marked |
| Screens | What does one participant see, screen by screen? | Only `verbatim` fields and transcribed questions. Unresolved step rules show as amber gaps |
| Outline | The previous card overview | unchanged |

Every view reads values from program fields. The views rearrange those values and never
write new scientific text.

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
In the bench, "Knobe 2003 · inferred only" is the same program without it, so the two can be
compared directly.

A future change to the HumanStudy-Bench agent prompt (`agent_pipeline/CLAUDE.md`) should ask
the agent to write this block. It is not part of this branch.
