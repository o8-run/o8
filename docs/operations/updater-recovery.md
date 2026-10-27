# Recover an older updater to 0.1.796

Use this procedure if an older macOS o8 app detects 0.1.796 but stays at
"Restart is waiting for lanes and terminals to become idle" when only saved
reviews or tasks waiting for input remain. Version 0.1.796 includes the corrected
parked-task restart flow. The affected older app needs a manual upgrade to reach it.

## Download

Open the [public 0.1.796 release](https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.796)
and download the [signed universal macOS installer](https://github.com/hurttlocker/o8-releases/releases/download/v0.1.796/o8_0.1.796_universal.dmg).
This installer supports Apple Silicon and Intel Macs on macOS 14 or later.

In the older app, hover over **Updates**, then choose **View release on GitHub**.
The release page is available immediately. The app caches release-note text for
up to six hours at each cache layer, so a previously opened panel can retain older
text. Open the public release page directly if the recovery instructions are absent.
There is no need to clear application data or caches.

## Replace the installed app

1. Let active workers, terminal commands, and connected CLI updates finish.
   Saved reviews and tasks waiting for input can remain parked.
2. Quit o8 normally with **o8 > Quit o8**. If a menu-bar instance remains, quit it
   before replacing the app.
3. Open the downloaded disk image. Replace **o8.app** in **Applications** with
   the app from the installer. Approve the normal replacement prompt.
4. Eject the disk image and launch **o8.app** from **Applications**.
5. Open **o8 > About o8** and confirm **0.1.796**. Check that your saved tasks,
   reviews, approvals, and holds are still present.

The app replacement leaves saved application data in place. Do not delete that
data, edit its databases, or close parked tasks to unblock the update. Keep macOS
signature checks enabled. If macOS reports a damaged or unverified app, stop and
report the exact message rather than disabling those checks.

App and connected CLI updates are separate. The About panel confirms the desktop
version; check each separately installed CLI through its own version command.

## After recovery

In 0.1.796, an update downloads and installs before a restart is attempted. If
only parked tasks remain, the Updates panel names them and offers **Restart now**.
That explicit confirmation preserves their saved state. Actual running work still
blocks a restart.

Manual recovery from an affected 0.1.795 installation to the signed 0.1.796 app
was verified with six parked tasks. The installed app launched at 0.1.796, and
the saved task identities, review state, approval, and hold remained intact.

If recovery fails, report the installed version, the exact updater or macOS
message, and whether work is running or parked in the
[updater recovery issue](https://github.com/o8-run/o8/issues/3807).
Do not include private task content, credentials, or database files.

## Channel identity and stale results

Stable checks require a manifest explicitly marked `stable`; beta and fallback
feeds apply the same identity rule. A missing marker is a publication migration
problem, not permission to accept another channel. Verify the artifact's signed
embedded build identity and the feed marker before investigating transport.
Never use an environment channel override to retry a candidate through the
stable publisher.

A check carries its native session, sequence, channel and enrollment generation.
A superseded completion must not clear a newer update or replace a current
result with a stale failure. Switching Beta back to Stable invalidates pending
checks and uses the usual version comparison, so a newer installed beta waits
for a newer stable release. See [release channels](release-channels.md) for the
independent beta mirror anchor, shared publication lock and Linux completion
rules. Promotion remains outside this recovery path (#4857).

A channel change also invalidates downloads and pending installs from the old
enrollment. The native install handoff rechecks that generation while holding
the same gate used to save channel preferences. Once an installer has started,
a channel save persists the requested choice separately and reports that it will
take effect when installation finishes. The installer keeps its original channel
through its callbacks; immediately after it returns, the last saved choice becomes
active and invalidates old candidates. Installer failure or refusal also releases
that held choice. If the installer exits the process first, startup applies the
saved choice before checking for updates. Settings shows the held choice while it
waits, then confirms that it is active. A preferences save error is reported as a
save error, independently of update-check failures.
Enrollment transitions write and sync a private staging file before replacing the
settings file atomically. An interrupted drain leaves the acknowledged held
choice intact. This private file is not registered for generic store-plugin exit
rewrites. A storage failure after installation does not turn a successful
binary replacement into an installation failure. Settings reports that applying
the saved choice will retry; new checks and installs retry that transition and
refuse transport or installation while it remains unresolved.
