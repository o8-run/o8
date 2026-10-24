# Settings control parity

This is a partial port of the desktop Settings surface. Ported rows share the existing server values and mutations. Missing rows have no native counterpart in this change; conditional desktop controls are included. No claim of complete Settings parity or macOS behavior is made.

| Desktop control | Native counterpart | Status |
| --- | --- | --- |
| Settings entry and close | Shell Settings button, Open settings command, Ctrl/Cmd+comma, Close / Escape | Ported |
| Settings search | Search across the 41 shared-default rows | Ported for those rows |
| Settings section navigation | General, Dispatch, Models & providers, Git & PRs, Worktrees & storage, API keys | Ported for those sections |
| Settings back / forward history and search across other sections | None | Missing |
| General: Model-generated titles | Model-generated titles (`autoTitleInferenceEnabled`) | Ported |
| General: Quiet mode | Quiet mode (`presentationQuietMode`) | Ported |
| General: Review notifications | Review notifications (`notificationsReviewReady`) | Ported |
| General: Share usage data | Share usage data (`productTelemetryEnabled`) | Ported |
| General: Share crash reports | Share crash reports (`crashReportsEnabled`) | Ported |
| General: Automatically upload local crash logs | Automatically upload local crash logs (`telemetryOptIn`) | Ported |
| Dispatch: Concurrent agents | Concurrent agents (`parallelCap`) | Ported |
| Dispatch: Overlapping work | Overlapping work (`overlapGate`) | Ported |
| Dispatch: Automatically fix failed checks | Automatically fix failed checks (`healBotEnabled`) | Ported |
| Dispatch: Investigate failures in chat | Investigate failures in chat (`supervisorAutoEscalate`) | Ported |
| Dispatch: Automatically review completed work | Automatically review completed work (`reviewContinuation`) | Ported |
| Dispatch: Merge approval | Merge approval (`requireApproval`) | Ported |
| Dispatch: Install app updates automatically | Install app updates automatically (`updateAutoApply`) | Ported |
| Dispatch: Explain completed changes | Explain completed changes (`packetExplainerEnabled`) | Ported |
| Dispatch: Create a summary after merge | Create a summary after merge (`buyinDocEnabled`) | Ported |
| Dispatch: Spending limit per task | Spending limit per task (`meteredPacketCostCapUsd`) | Ported |
| Dispatch: Backup input-token limit | Backup input-token limit (`meteredPacketInputTokenCap`) | Ported |
| Dispatch: UI loop iterations | UI loop iterations (`uiLoopMaxIterations`) | Ported |
| Dispatch: UI loop minutes | UI loop minutes (`uiLoopMaxMinutes`) | Ported |
| Dispatch: UI loop diff bytes | UI loop diff bytes (`uiLoopMaxDiffBytes`) | Ported |
| Dispatch: UI loop diff files | UI loop diff files (`uiLoopMaxDiffFiles`) | Ported |
| Dispatch: UI loop preview timeout | UI loop preview timeout (`uiLoopPreviewTimeoutMs`) | Ported |
| Dispatch: Workspace manifest execution | Workspace manifest execution (`workspaceManifestPolicy`) | Ported |
| Providers / model defaults: Answer routing | Answer routing (`brainRoutingMode`) | Ported |
| Providers / model defaults: Codex model | Codex model (`brainCodexModel`) | Ported |
| Providers / model defaults: Codex effort | Codex effort (`brainCodexEffort`) | Ported |
| Providers / model defaults: Show chats in the Codex app | Show chats in the Codex app (`codexAppThreads`) | Ported |
| Providers / model defaults: Thinking effort | Thinking effort (`thinkingEffort`) | Ported |
| Providers / model defaults: Prompt caching | Prompt caching (`promptCachingEnabled`) | Ported |
| Providers / model defaults: Brain answer model | Brain answer model (`classAComposer`) | Ported |
| Providers / model defaults: Brain uses Claude CLI | Brain uses Claude CLI (`brainUseClaudeCli`) | Ported |
| Providers / model defaults: Pre-warm Brain runtimes | Pre-warm Brain runtimes (`brainWarmupEnabled`) | Ported |
| Providers / model defaults: Workers use the Brain | Workers use the Brain (`workersUseBrain`) | Ported |
| Git & PRs: Branch prefix | Branch prefix (`branchPrefix`) | Ported |
| Git & PRs: Tag commits created by agents | Tag commits created by agents (`commitAttributionEnabled`) | Ported |
| Git & PRs: Open pull requests | Open pull requests (`prLinkDestination`) | Ported |
| Worktrees & storage: Workspace count per repository | Workspace count per repository (`worktreeMaxCount`) | Ported |
| Worktrees & storage: Disk usage per repository | Disk usage per repository (`worktreeMaxTotalGb`) | Ported |
| Worktrees & storage: Parking mode | Parking mode (`workspaceParkingMode`) | Ported |
| Worktrees & storage: Volume reserve | Volume reserve (`storageReserveRatio`) | Ported |
| Worktrees & storage: Absolute floor | Absolute floor (`storageReserveFloorGb`) | Ported |
| Dispatch: Edit in settings.toml, Save, Reload, Back to form | Edit settings.toml, Save, Reload file, Cancel; revision conflict refusal | Ported |
| Provider keys: OpenRouter, DeepSeek, Anthropic, OpenAI add / replace / cancel / confirm removal | API keys: Add / Replace, Save / Cancel, Remove / Confirm / Cancel; presence only | Ported |
| OpenRouter connection: enable / disable / recheck | Turn on / off, Recheck connection, connection state and server refusals | Ported |
| Quick drawer: Settings | Shell Settings button and shortcut | Ported as shell entry |
| Provider key masked previews | Intentionally never retained or shown; presence only | Ported (presence only) |
| `GeneralTab.tsx`: Launch at login; When closing with active agents | None | Missing |
| `AccountTab.tsx`: Manage account; Sign in to o8; Session | None | Missing |
| `GitHubTab.tsx`: Connect GitHub; Refresh; GitHub identity; Repository & CLI access; Disconnect; enter this code on github; Open GitHub; Use an access token instead; Connect; Automation app; Install; Sign in | None | Missing |
| `IndexingTab.tsx`: Loading index state…; Couldn't read index state; No repositories connected yet; Saved instructions; Recorded task outcomes; Knowledge storage | None | Missing |
| `WorktreeRetentionSection.tsx`: Workspace files; Disk space used; Total file size; Refresh; Space for new tasks; Free on disk; Set aside for tasks; Available for new tasks; Fleet parking; Parked; Eligible repos; Opted out; Allocated; Logical | None | Missing |
| `MCPTab.tsx`: Claude Desktop; Claude Code | None | Missing |
| `ConnectionsTab.tsx`: Connect this Mac; Text Symon; Show pairing QR | None | Missing |
| `ProjectsPanel.tsx`: New project; Repositories; Context; Locks; All projects; Edit; Create your first project | None | Missing |
| `VoiceTab.tsx`: Open Symon settings; Accessibility; Input Monitoring; Fn key binding; Mic input; Top pill; Live dictation; External keyboard Fn; Groq API key; Escalation; Conversation provider; Background provider; Model preset; Model | None | Missing |
| `DiagnosticsTab.tsx`: Check installed tools; No tools detected; Feature diagnostics; Archive old Codex sessions; archived; deleted; missing cwd; older than d; skipped; 0 skipped; Factory reset; removed; failed; Developer tools; Developer diagnostics | None | Missing |
| `AboutTab.tsx`: Version; Platform; Mode; Check for updates; GitHub; Documentation; Releases; Replay onboarding; Reset + run onboarding; Preview onboarding; View detection | None | Missing |
| `ChatGPTPlanConnection.tsx`: Sign in to o8; Continue with ChatGPT; ChatGPT account; Add account; Plan access; Manage usage; Disconnect; Cancel; Got it | None | Missing |
| `CliUpdatePrompt.tsx`: Check tool versions | None | Missing |
| `LocalAcpSection.tsx`: Browse agents; Save connection; Check connection; Cancel; Disconnect; Remove connection | None | Missing |
| `ModelsTab.tsx`: Routing details; API keys; Local models; Task review & supervision | None | Missing |
| `ProviderRuntimeDetails.tsx`: Availability; Managed model; Use in a conversation; Usage and limits; Setup; Account status; Version; Binary path; Observed connection; Model selection; Worker effort; Loading model settings…; Show in dispatch pickers; Claude fallback model; Runtime configuration | None | Missing |
| `PluginTaskReview.tsx`: Refresh; Launch reviewed task; Inspect attempt; Stop attempt; Cancel; Stop worker | None | Missing |
| `ExternalMcpServersSection.tsx`: env; edit; operator; cortex; command or url; Advanced JSON; mcp config json; Manual setup; name; transport; args json array; env json object | None | Missing |
| `AccessPointDiagnostics.tsx`: Backend; Install mode; CLI installed; CLI on PATH; CLI Node; Node.js; Codex CLI; GitHub CLI; Database; Webview tools | None | Missing |
| `ClientRows.tsx`: Remove | None | Missing |
| `PairedDevicesSection.tsx`: Revoke; Cancel; Refresh | None | Missing |
| `SymonIMessageAccessSection.tsx`: Allow Symon on iMessage; Use OpenClaw for iMessage; Grant full access; Cancel | None | Missing |
| `SymonMessagesReceiverSection.tsx`: Confirm enable; Cancel; Save senders; Refresh status | None | Missing |
| `ApfsDependencyImagesRow.tsx`: Reuse dependencies (APFS) | None | Missing |
| `DispatchTaskSettings.tsx`: Native browser-view | None | Missing |
| `OrgSuggestionStrip.tsx`: Group; Dismiss | None | Missing |
| `ProjectCard.tsx`: Confirm; Cancel; Edit; Delete; Instructions; Locks; Add files | None | Missing |
| `ProjectForm.tsx`: Cancel | None | Missing |
| `ProjectRepoRows.tsx`: Set main; Repositories | None | Missing |
| `SymonAttentionSettingsSection.tsx`: Automatic AI commentary; Spoken updates; Hourly budget; Quiet hours; Quiet window; Work needs you; Approvals; Review verdicts; Failures and limits; Completed work; Calendar events; Calendar lead time; Time check-ins | None | Missing |
| `SymonTextBrainSection.tsx`: Retry | None | Missing |
| `SymonConversationsSection.tsx`: Browse saved conversations; Back to conversations; Refresh; Close history | None | Missing |
| `RecallHealthSection.tsx`: Outcomes count; Directives count; Recall p50 (24h); Recall p95 (24h); Recall p99 (24h); Recall p95 (7d); Substrate health | None | Missing |
| `LoopStatusSection.tsx`: Retry PR count; Cron; Open PRs; Active lanes; Recent merges; Prompt | None | Missing |
| `ShippedDarkAuditSection.tsx`: Default-off feature flags | None | Missing |
| `DiagnosticsResetModals.tsx`: cancel; close | None | Missing |
| `ReportIssueSection.tsx`: Remove; Attach a screenshot — click, paste, or drop an image; Retry | None | Missing |
| `AcpRegistryPicker.tsx`: Close; Prepare agent; Refresh agents; Local setup | None | Missing |
| `RuntimeBillingRow.tsx`: Who pays | None | Missing |
| `LocalModelsSection.tsx`: Dispatch model; Ollama; LM Studio; Cloud; Local endpoint; Ollama :11434; LM Studio :1234; Chat model; qwen2.5-coder:7b; qwen2.5-coder:32b; Embedding model | None | Missing |
| `ModelRoutingControls.tsx`: Lead provider; Code review provider; Subscription profile; Default worker; Your Pi setup; Advanced orchestrator options; OpenCode fallback model; Combined answer provider; Existing setup uses Claude; Advanced worker setup; Codex launch method; Worker quota fallback | None | Missing |
| `DispatchFoundersSection.tsx`: Thinking & task models; Adaptive orchestrator thinking; Show Ultra effort; Targeting — triage tier; Targeting — action tier; Brain advanced | None | Missing |
| `AgentRoleRoutingSection.tsx`: Configured; Effective; Source; Availability; Why; Change in; Last ran; Last fallback; Fallbacks | None | Missing |
| `OpenRouterModelsSection.tsx`: Show all hidden models | None | Missing |
| `ClaudeCodeHarnessSection.tsx`: Model source; Model; Codex authorization | None | Missing |
| `MuseConnectionSection.tsx`: Sign in; Models; Check models; Usage | None | Missing |
| `ProviderCapabilitiesSection.tsx`: Worker actions; Session transforms; Usage; Account limits | None | Missing |
| `ExternalMcpServerRow.tsx`: yes; cancel; remove | None | Missing |
| `AcpModelPickerPopover.tsx`: Clear | None | Missing |
| Appearance: Light, Dark, All Glass, glass/transparency preference | Existing native theme tokens are used, but these preferences are not editable here | Missing |
| Permissions: Microphone, Accessibility, Input Monitoring, Screen Recording; Refresh / Grant / Open System Settings / Relaunch | None | Missing |
| Native voice keys: Gemini (Symon & voice), OpenRouter voice mirror, Groq, ElevenLabs, Google Cloud TTS; save / remove | None | Missing |
| Voice shortcuts, Fn calibration and Symon settings window | None | Missing |
| OpenRouter usage / limits / last-check details, model inventory, hidden models and documentation link | Connection state and recheck only; detailed rows absent | Missing |
| Quick drawer: Account, Light / Dark / All Glass, keyboard shortcuts, community, documentation and help | None | Missing |
| Quick-drawer capacity rows: quota observations, Refresh capacity, register / select identity | None | Missing |
| Projects: repository picker, add / remove / reorder repositories, context files and lock rules | None | Missing |
| Indexing: repository selection / reindex, knowledge and recall readouts | None | Missing |
| MCP: server create / edit / toggle / delete, install / remove client configuration, task review / launch / stop | None | Missing |
| Mobile: relay connection, pairing QR, paired-device revoke, Messages sender controls | None | Missing |
| Analytics: metric views, time-range / source filters and refresh | None | Missing |
| Diagnostics: tools / features / recall / loop status, issue report with attachments, session archive, reset confirmations and developer diagnostics | None | Missing |
| About: version / platform / mode, update check, documentation / repository / releases, replay / reset / preview onboarding and detection | None | Missing |

The startup, appearance, permission and voice controls currently use local storage or Tauri bridge/plugin APIs in the desktop implementation. This change adds no replacement persistence service or direct native credential store. Other unported server-backed subsystems still need their own GPUI action and refusal coverage.
