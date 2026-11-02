# Image input verification

The GPUI regression drives actual Cmd+V and platform Entered/Submit drop events,
then clicks the real Send control and reads the production queue route again.
It also removes an image before sending and checks the persisted empty image list.

## Main with new regressions

```text
Cmd+V must attach the clipboard image
  left: 0
 right: 1
platform PNG drop must attach
  left: 0
 right: 1
test result: FAILED. 1 passed; 3 failed; 0 ignored
```

## Fixed implementation

```text
test result: ok. 4 passed; 0 failed; 0 ignored
```

A valid PNG above 1 MiB retains its original bytes. Four images attach; the fifth
shows the desktop capacity error. Text paste retains selection replacement and
CRLF normalization. Decode and file reads run on the background executor; chips
reuse decoded buffers. No transcript path is opened by this change.

## Linux fixture frames

Both captures use the real X11 software-Vulkan renderer, the production history
route fixture, and an external PNG clipboard selection pasted with Ctrl+V.

[Dark](dark.png) and [light](light.png).

## Suite comparison

The local exact-main full suite stalls during fixture startup: process IDs inside
the execution namespace do not resolve in /proc. The fixture reports current
process identity unknown and cannot acquire its workspace lifecycle lease.
No process-identity check was bypassed. Hosted native suite receipts supply the
complete main-versus-head comparison in the PR.
