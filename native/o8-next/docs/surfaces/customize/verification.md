# Native Customize slice (#4548)

The opt-in shell opens Customize from its toolbar. It uses shared theme tokens,
the existing Client and Composer, and the desktop inventory and prompt-library
routes with operator-token auth. This is a partial port. It changes no installed
app defaults, packages, dependency licenses, versions or release configuration.

| Desktop control | Native counterpart | Status |
| --- | --- | --- |
| Open / close Customize | Toolbar Customize / Close Customize | Ported |
| Retain view when reopening | Cached view for the same repository | Ported |
| Automatic inventory refresh after external changes | Manual Refresh | Missing automatic refresh |
| Instructions tab | Instructions | Ported authored inventory |
| Prompts tab | Prompts | Ported manual library actions below |
| Skills tab | Skills | Ported metadata inventory only |
| Connections tab | Connections | Ported basic metadata and built-in entries |
| Agents tab | Agents | Ported metadata inventory only |
| Hooks tab | Hooks | Ported event/command inventory; matcher display missing |
| Commands tab | None | Missing |
| Plugins tab | None | Missing |
| Search current section | Search editor; title/body/tag matching | Ported |
| Personal scope | Personal | Ported |
| Repository + personal scope | Repository-name button | Ported for the workspace selected at open |
| All project repositories scope | None | Missing multi-repository project view |
| Refresh / retry | Refresh | Ported |
| Expand prompt text | Full text inline | Ported |
| Create prompt | Save a prompt | Ported |
| Edit prompt | Edit | Ported |
| Prompt title / body / tags | Native editors | Ported |
| Prompt editor scope / repository selector | Initial view scope, preserved on edit | Missing reassignment controls |
| Save / cancel prompt editor | Save / Cancel | Ported |
| Copy prompt | Copy | Ported |
| Delete prompt / confirm / cancel | Delete / confirmation / Cancel | Ported |
| Insert prompt into active composer / record use | None | Missing |
| Inspect prompt import sources | None | Missing |
| Select / confirm / cancel prompt imports | None | Missing |
| Edit / save / cancel shared project instructions | None | Missing |
| Preview project task brief | None | Missing |
| Expand authored directive | Body inline | Ported read |
| Open directive backing file | None | Missing |
| Forget directive / confirm / cancel | None | Missing |
| Indexed documentation reference section | None | Missing; excluded from authored inventory |
| Add skill / choose target scope / create | None | Missing |
| Import skill file | None | Missing |
| Browse / search skill bundles | None | Missing |
| Install / enable / disable / remove skill bundle | None | Missing |
| Skill file / full content view | None | Missing |
| Built-in command copy / insert | None | Missing |
| Manage connections in Settings | None | Missing |
| Agent backing-file view | None | Missing |
| Hook backing-file view | None | Missing |
| Plugin catalog / category / search / details | None | Missing |
| Plugin install / update / remove / enable / disable | None | Missing |
| Plugin target repository / terminal actions | None | Missing |

`shell_tests.rs` opens the actual shell and drives GPUI clicks, editors and the
clipboard. `scripts/next/dev-server.ts --customize` hosts production middleware,
repository, inventory, directives, MCP-server and prompt-library handlers. Its
filesystem input is an owned disposable profile and registered repository; it
never inspects account files. Database writes and refusal/validation behavior
are production code. Assertions canonicalize repository paths on both sides.

The first [red run](red-tail.txt) fails both regressions at `customize-open`.
The [green run](green-tail.txt) passes both new cases and both existing shell
regressions: 0/2 to 2/2 new cases; 4/4 touched shell cases. It covers scoped
inventories, search/no matches, empty prompts, create, update, edit cancellation,
copy, confirmed deletion, deletion cancellation, server validation and auth retry.
Save transport failures, cross-workspace switching and every missing action above
still need coverage. Customize keeps the repository chosen at open; its button
names that repository. Typing in Customize does not invoke shell tab shortcuts.

[Timing receipt](run-1.json) records one debug Linux headless GPUI run. Open timing
includes toolbar click, async HTTP and CPU scene drawing; interaction timing is
search input through its resulting scene. Before latency is unavailable because
base has no native surface. Test text, debug CPU scenes and one sample do not
establish GPU/compositor, physical input, macOS display latency or a production
latency target. No speedup is claimed.


## Current main integration

Reconciled with the native Inbox already on main. The final [green run](green-main-tail.txt)
passes **10 shell and Inbox cases**. The [second timing receipt](run-2.json)
records **61.85 ms open-to-first-frame** and **40.61 ms interaction-to-frame**
on the same debug/headless CPU endpoint. Earlier receipts remain in place.
No GPU/compositor or macOS display claim is added.


The [retention red](red-retain-tail.txt) caught view selection being reset on
reopen. The view now stays cached for its repository, and shell focus capture
pauses while Customize owns input. Prompt fields render immutable while requests
are in flight; detailed pending-input timing coverage remains open. The final
[green run](green-final-tail.txt) includes the complete CRUD and reopen story,
plus existing shell/Inbox cases: 10/10. [Final timing](run-3.json): 41.64 ms open
to CPU frame; 31.27 ms search to CPU frame, with the same endpoint limitations.

Refs #4548
