# Visual clarification transitions

Each cell has one outcome. This table governs answers to clarification questions,
not unrelated Live requests. An answer never sends a choice by itself.

`Typed answer` selects option 1 with the dialog's keyboard control when a question
is open. Otherwise it edits the composer text. `Live answer` says `first`.
`Dismiss` presses Escape. `Timeout` advances 1,500 ms with no Send pending.
The meaning resolver returns a choice after target confirmation and returns none
for the single-target `none` fixture. Meaning answered includes accepted and
skipped meaning choices. Delivery status is separate: saving, saved, and unknown
drafts have no open question.

| Question state | Typed answer | Live answer | Send | Dismiss | Timeout |
| --- | --- | --- | --- | --- | --- |
| none | Edit draft | Retain answer without sending | Send unchanged instruction | Keep draft | Keep draft |
| target open | Confirm target | Confirm target | Keep target question open | Dismiss target | Keep target question open |
| target dismissed | Edit draft | Consume closed answer | Send unchanged instruction | Keep dismissed target | Keep dismissed target |
| target confirmed | Edit draft | Consume closed answer | Open meaning question | Keep confirmed target | Keep confirmed target |
| meaning open | Answer meaning | Answer current meaning | Keep meaning question open | Skip meaning | Keep meaning question open |
| meaning answered | Edit draft | Consume closed answer | Send answered instruction | Keep answered meaning | Keep answered meaning |

There are 6 states by 5 inputs, or 30 cells. Only the three Send cells that name
an instruction dispatch it. Choices require a later explicit Send.

Routing first identifies the one current open question. Its answer vocabulary
takes priority over all closed questions, including shared ordinals. When no
question is open, `skip`, ordinals, option values, and option labels from closed
questions are consumed. This rule also applies after delivery. Obsolete answers
cannot mutate a newer draft. A timeout cannot authorize a new send; only the
Send already waiting for a resolver may use its unchanged-instruction fallback,
within the existing 1,500 ms budget including advisory receipt publication.
