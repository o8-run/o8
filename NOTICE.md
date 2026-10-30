# Third-party notices

o8 includes third-party packages and adaptations whose authors retain their
copyrights. Those works remain subject to their own licenses; the o8 MIT
license does not replace or narrow those terms.

## Code diff rendering

- Packages and versions: `@pierre/diffs` 1.5.2, `@pierre/theme` 2.0.0,
  and `@pierre/theming` 1.0.1
- Copyright: Copyright 2025 Pierre Computer Company
- License: Apache License 2.0
- Upstream: <https://github.com/pierrecomputer/pierre>
- Use in o8: syntax-highlighted pull request patches
- Unmodified license texts: [diffs](licenses/diffs-Apache-2.0.txt),
  [theme](licenses/theme-Apache-2.0.txt), and
  [theming](licenses/theming-Apache-2.0.txt)
- The theme's [upstream notice](licenses/pierre-theme-NOTICE.md), including
  the original Primer MIT attribution, is retained with these distributions.

## Workspace file explorer

- Packages and versions: `@pierre/trees` 1.0.0-beta.6 and
  `@pierre/theming` 1.0.0
- Copyright: Copyright 2025 Pierre Computer Company
- License: Apache License 2.0
- Upstream: <https://github.com/pierrecomputer/pierre>
- Use in o8: the compact workspace file tree and its file-type icons
- Unmodified license texts: [trees](licenses/trees-Apache-2.0.txt) and
  [theming](licenses/theming-Apache-2.0.txt)
- The trees package's [upstream notice](licenses/pierre-trees-NOTICE.md),
  including its original headless-tree MIT attribution, is retained.

The explorer also uses `preact` 11.0.0-beta.0 and `preact-render-to-string`
6.6.5 under the MIT license. Their unmodified copyright and permission notices
are retained in [Preact](licenses/preact-MIT.txt) and
[Preact render-to-string](licenses/preact-render-to-string-MIT.txt).

## Algorithms and techniques

### FLIP/PIC fluid simulation

- Author: Matthias Müller
- Tutorial: "How to write a FLIP water simulator" (Ten Minute Physics)
- Source: <https://matthiasmueller.info/tenMinutePhysics/>
- Use in o8: the independently implemented solver in
  `src/app/preview/effects/flip-fluid.ts`, rendered as ASCII glyphs by
  `src/app/preview/effects/LiquidAscii.tsx`

The credit is for Müller's publicly published FLIP/PIC algorithm and
educational explanation. The o8 implementation was written independently; no
React Bits source code or implementation was used.

## Lisse Core and Lisse React

- Packages and versions: `@lisse/core` 0.4.0 and `@lisse/react` 0.4.0
- Copyright: Copyright (c) 2026 Jace Attard
- License: MIT
- Upstream: <https://github.com/JaceThings/Lisse>
- Use in o8: smooth-corner geometry across dashboard and preview surfaces

## Visual Studio Code Codicons

- Package and version: `@vscode/codicons` 0.0.45
- Copyright: Microsoft Corporation
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Upstream: <https://github.com/microsoft/vscode-codicons>
- License text: <https://creativecommons.org/licenses/by/4.0/legalcode>
- Use in o8: `scripts/postinstall.mjs` copies the unmodified `codicon.ttf`
  font into Monaco when Monaco's bundled font is absent

**Attribution is mandatory under CC BY 4.0.** The Codicons name, Microsoft as
creator, the upstream URL, and the CC BY 4.0 license link above must remain
with distributions that include the font. o8 does not claim that Microsoft
endorses o8.

## Phosphor Icons

- Packages and versions: `@phosphor-icons/core` 2.1.1 and
  `@phosphor-icons/react` 2.1.10
- Copyright: Copyright (c) 2023 Phosphor Icons
- License: MIT
- Upstream: <https://github.com/phosphor-icons/core>
- Use in o8: icons plus raw regular-weight SVG path data inlined into Tauri
  webview source, including `src/components/mobile-split-shell/DevHostFrame.tsx`

## Lucide Icons

- Package and version: `lucide-react` 0.577.0
- Copyright: Copyright (c) for portions of Lucide are held by Cole Bemis
  2013-2026 as part of Feather (MIT). All other copyright (c) for Lucide are
  held by Lucide Contributors 2026.
- License: ISC, with portions derived from Feather under MIT
- Upstream: <https://github.com/lucide-icons/lucide>
- Use in o8: icon glyph data imported from the package and rendered through
  `src/components/desktop/lucide-shims.tsx`, which draws each icon's
  `__iconNode` data as raw SVG to work around a Tauri webview rendering
  failure in the library's React component tree

The ISC permission notice reproduced from the package:

> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
> ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
> ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
> OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The Feather-derived portions additionally carry Cole Bemis's MIT notice; the
MIT permission text at the end of this file applies to them.

## Tabler Icons

- Package and version: `@tabler/icons-react` 3.44.0
- Copyright: Copyright (c) 2020-2026 Paweł Kuna
- License: MIT
- Upstream: <https://github.com/tabler/tabler-icons>
- Use in o8: icon glyph data imported from the package and rendered through
  `src/components/desktop/tabler-shims.tsx` using the same raw-SVG approach as
  the Lucide shim, for specific glyphs chosen on legibility grounds

## Iconoir

- Package and version: `iconoir-react` 7.11.0
- Copyright: Copyright (c) 2021 Daniel Martin
- License: MIT
- Upstream: <https://github.com/iconoir-icons/iconoir>
- Use in o8: selected interface icons

## Paper Design Shaders

- Packages and versions: `@paper-design/shaders` 0.0.76 and
  `@paper-design/shaders-react` 0.0.76
- Copyright holder: Paper Design
- License: Apache License 2.0
- Upstream: <https://github.com/paper-design/shaders>
- License text: <https://www.apache.org/licenses/LICENSE-2.0>
- Use in o8: shader backdrops in the canvas-glass preview

The upstream NOTICE reads:

> Powered by Paper Shaders: <https://shaders.paper.design>

Apache-2.0 redistribution requires a copy of the license, prominent notices on
modified files, retention of relevant copyright, patent, trademark, and
attribution notices, and preservation of applicable upstream NOTICE text. The
notice above is reproduced here for that purpose.

## DOMPurify

- Package and version: `dompurify` 3.4.12
- Copyright and authorship: Dr.-Ing. Mario Heiderich, Cure53, and DOMPurify
  contributors
- License offered upstream: MPL-2.0 OR Apache-2.0
- License option used by o8: Apache License 2.0
- Upstream: <https://github.com/cure53/DOMPurify>
- License text: <https://www.apache.org/licenses/LICENSE-2.0>
- Use in o8: sanitizing rendered HTML

## TweetNaCl and TweetNaCl-util

- Package and version: `tweetnacl` 1.0.3
  - Authors: TweetNaCl-js contributors
  - Upstream: <https://github.com/dchest/tweetnacl-js>
- Package and version: `tweetnacl-util` 0.15.1
  - Authors: TweetNaCl-js contributors
  - Upstream: <https://github.com/dchest/tweetnacl-util-js>
- License for both works: The Unlicense
- Use in o8: end-to-end encryption helpers

The Unlicense dedication reproduced from these packages:

> This is free and unencumbered software released into the public domain.
>
> Anyone is free to copy, modify, publish, use, compile, sell, or distribute
> this software, either in source code form or as a compiled binary, for any
> purpose, commercial or non-commercial, and by any means.
>
> In jurisdictions that recognize copyright laws, the author or authors of
> this software dedicate any and all copyright interest in the software to
> the public domain. We make this dedication for the benefit of the public at
> large and to the detriment of our heirs and successors. We intend this
> dedication to be an overt act of relinquishment in perpetuity of all present
> and future rights to this software under copyright law.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
> ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
> WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
>
> For more information, please refer to <https://unlicense.org/>.

## tauri-plugin-mcp

- Package and version: `tauri-plugin-mcp` 0.1.0
- Author and copyright holder identified by the package manifest: Pegleg
- License: MIT, as declared by the published package manifest
- Upstream: <https://github.com/P3GLEG/tauri-plugin-mcp>
- Package record: <https://www.npmjs.com/package/tauri-plugin-mcp/v/0.1.0>
- Use in o8: optional development-only MCP access to the Tauri webview

This entry records the package's MIT declaration and upstream source
explicitly instead of relying on incomplete lockfile metadata.

## Skiper UI adaptations

- Components and versions: unversioned Skiper UI free component pages
  `skiper99` (Animated icons 002) and `skiper87` (Scroll with fade effect),
  adapted in May 2026
- Creator and copyright holder: Skiper UI (Gur__vi / gxuri.me)
- License: Skiper UI free-component terms permit personal and commercial use
  and modification, with attribution to Skiper UI required
- Animated-icons source: <https://skiper-ui.com/v1/skiper99>
- Scroll-fade source: <https://skiper-ui.com/v1/skiper87>
- Use in o8: animated title-bar icon behavior and the scroll-fade mask

The `skiper87` source additionally credits the original scroll-masking work to
jh3yy and the recreation to Gustav Ekerot. Those credits are preserved here.
These are adaptations; o8 does not claim authorship of the upstream patterns.

## IntentUI Tracker adaptation

- Component and version: unversioned Tracker recipe from the IntentUI 3.x
  documentation, adapted in May 2026
- Copyright: Copyright (c) 2024 Irsyad A. Panjaitan
- License: MIT
- Upstream: <https://github.com/intentui/intentui>
- Recipe: <https://intentui.com/docs/components/visualizations/tracker>
- Use in o8: the desktop session timeline's variable-width activity strip

This is an adaptation of the Tracker recipe to o8's inline-style and theme-token
conventions.

## Roughdraft Flavored Markdown

- Package and version: `@roughdraft/rfm` 0.1.0
- Copyright holder recorded by o8: Nathan Baschez / Lex, Inc.
- License: MIT
- Upstream: <https://github.com/Lex-Inc/roughdraft/tree/main/packages/rfm>
- Use in o8: vendored o8.md review parser at `src/lib/o8md/rfm.ts`
- Full local notice and license text: `licenses/roughdraft-MIT.txt`

The upstream repository declares MIT in package metadata and its README but
does not currently contain a standalone LICENSE file. The local Roughdraft
notice records that provenance caveat and should remain with distributions.

## MIT permission notice for third-party works

The copyright notices above and the following terms apply to the Lisse,
Phosphor Icons, Tabler Icons, Iconoir, the Feather-derived portions of Lucide,
tauri-plugin-mcp, IntentUI, and Roughdraft works identified in this file:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The applicable copyright notice above and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Native CLI usage readers

- Copyright: Copyright (c) 2026 T3 Tools Inc.
- License: MIT
- Upstream: <https://github.com/t3tools/t3code>
- Use in o8: adapted native transcript, SQLite, metadata, and pricing readers
- License text: [usage readers](src/lib/usage/history-readers/LICENSE.txt)

## o8 next right panel tab strip

- Copyright: Copyright (c) 2026 T3 Tools Inc.
- License: MIT
- Upstream: <https://github.com/pingdotgg/t3code> at commit
  `5b4f2aa1532730d4dd51d2cb48a57ff74a0f54eb`, files
  `apps/web/src/components/RightPanelTabs.tsx` and
  `apps/web/src/components/ui/panel-tab-close-button.tsx`
- Use in o8: the tab strip, add menu, and hover close control in
  `native/o8-next/src/shell_features/right_panel.rs`
- License text: [T3 Code](src/lib/usage/history-readers/LICENSE.txt)

## o8 next inbox sidebar

- Copyright: Copyright (c) 2026 T3 Tools Inc.
- License: MIT
- Upstream: <https://github.com/pingdotgg/t3code> at commit
  `f58fad04162165653bf06f0c987bbfb0074a8a4b`, files
  `apps/web/src/components/Sidebar.tsx`,
  `apps/web/src/components/Sidebar.logic.ts`,
  `apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx`,
  `apps/web/src/components/sidebar/SidebarThreadRow.tsx`,
  `apps/web/src/hooks/showThreadUndoNotice.ts` and
  `apps/web/src/components/threadActionMenu.logic.ts`
- Use in o8: the repository scope picker and the thread row's Filter by
  menu in `native/o8-next/src/surfaces/sidebar/scope.rs`; the By repo
  folders and their attention dot in
  `native/o8-next/src/surfaces/sidebar/folders.rs`; the Inbox view's
  Active and Settled sections, Settle and Un-settle, park-and-advance and
  the Undo notice in `native/o8-next/src/surfaces/sidebar/inbox.rs`
- License text: [T3 Code](src/lib/usage/history-readers/LICENSE.txt)

## o8 next update control states

- Copyright: Copyright (c) 2026 T3 Tools Inc.
- License: MIT
- Upstream: <https://github.com/pingdotgg/t3code> at commit
  `5b4f2aa1532730d4dd51d2cb48a57ff74a0f54eb`, files
  `apps/web/src/components/sidebar/DesktopUpdateStatusIcon.tsx` and
  `apps/web/src/components/ProviderUpdatesAction.tsx`
- Use in o8: the update button's checking, download progress and restart
  states, and "Update all" for connected tools, in
  `native/o8-next/src/shell_features/update.rs`
- License text: [T3 Code](src/lib/usage/history-readers/LICENSE.txt)
