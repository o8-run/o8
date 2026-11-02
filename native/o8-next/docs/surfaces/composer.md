# Composer controls and text input

The existing session surface owns the composer card in `src/composer/card.rs`,
included by `conversation.rs`. Retained sibling scenes isolate typing from the
surrounding conversation and shell.
The generic native input handler remains in `src/composer.rs`.

The footer places mode, access and attach on the left; model, effort, microphone
and Send on the right. The field names the selected mode in its placeholder.
There is no permanent shortcuts or routing hint beneath the field.

| Control | Existing server contract |
| --- | --- |
| Mode | Queue payload `routing.pickedMode`, `routing.mode` and the production composer directive |
| Access | Saved assistant permission receipt, then queue payload `routing.permissionMode` |
| Model | Saved session model; changes write `orchestratorModel` through operator defaults |
| Effort | Saved effort receipt or operator default; changes write `thinkingEffort` |
| Send | Existing durable composer queue, frozen identity and routing, confirmed receipt |

Model and effort updates read back the effective server value before changing
the next send. Refused updates retain the previous selection and the draft.
An asynchronous completion belongs to its originating composer; changing sessions
cannot apply it to another draft or take that draft's focus.

## Shortcuts reference

Command means Cmd on macOS or Ctrl on Linux. Ctrl aliases for clipboard and undo
remain supported on macOS. Word movement uses Option on macOS and Ctrl on Linux.

| Input | Action |
| --- | --- |
| Enter | Send |
| Shift+Enter | New line |
| Command+Shift+Enter | Switch Steer / Queue |
| Tab from the text field | Focus the session sidebar |
| Shift+Tab from the text field | Enter the footer controls |
| Tab / Shift+Tab on controls | Move keyboard focus |
| Enter / Space on a control | Activate it |
| Escape in a picker | Close it and restore its opening control's focus |
| Shift+arrows | Extend selection |
| Word modifier + Left / Right | Move by word; add Shift to select |
| Home / End | Move to the hard line boundary; add Shift to select |
| Cmd+Left / Right on macOS | Move to the hard line boundary |
| Cmd+Up / Down on macOS; Ctrl+Home / End on Linux | Move to the document boundary |
| Word modifier + Backspace / Delete | Delete a word |
| Command+A / C / X / V | Select all / copy / cut / paste |
| Command+Z / Command+Shift+Z | Undo / redo; Ctrl+Y also redoes |
| F6 / F7 | Steer / remove the first eligible queued message |
| Double-click / triple-click | Select a word / hard line |

IME marked text owns confirmation, movement and deletion until committed.
Composition commits form one undo transaction. Undo also preserves the active
selection end. Selection and composition decorations use shaped text runs,
including wrapped and right-to-left input, without per-character position scans.
The editor accepts 1 MiB multiline and single-line pastes; sending remains subject
to the existing server payload limits.

## Remaining parity

The model chip opens a server-validated model-ID editor, rather than the complete
current model catalogue. The microphone occupies its footer slot but is disabled;
native recording and transcription are not implemented. Image-capable runtimes
accept clipboard images with Command+V, platform image-file drops onto the card,
and the native image picker. Thumbnail chips have a remove control. All three
paths share the desktop manual limit of four images and 5 MiB per image, preserving
original bytes without downscaling. The separate agent upload bridge retains its
1 MiB cap. Sending is still subject to the existing queue route's data-URI limit
of fewer than 5,000,000 characters per image. Oversized or unreadable uploads
show an error. Pending reads belong to their originating draft and block Send.
The platform file dialog and actual audio hardware are not exercised by the
headless fixture host.

The tests use GPUI's headless test text system. They establish logical Unicode,
UTF-16, composition and selection behavior, CPU paint acknowledgement and compact /
wide bounds. Real font shaping, visual bidirectional layout, macOS execution and
GPU/compositor presentation remain unverified in Linux Cloud.

See [verification receipts](composer/verification.md) and the
[final image-only Send review](composer/final/verification.md).
