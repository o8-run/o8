# o8 on Omarchy / Hyprland

o8's Linux build is a preview. These notes cover Omarchy (Arch + Hyprland) and
other Wayland compositors.

## Install

- **AUR (recommended on Arch/Omarchy):** `yay -S o8-bin` (or Omarchy menu ›
  Install › AUR › `o8-bin`). It repackages the release `.deb` and uses Arch's
  `webkit2gtk-4.1` and `gtk3`. The PKGBUILD lives in
  [`packaging/aur/o8-bin`](../../packaging/aur/o8-bin/PKGBUILD).
- **AppImage:** works, but a bundled `libwayland` can paint a blank window on
  Arch. If it does, start it with
  `LD_PRELOAD=/usr/lib/libwayland-client.so ./o8_*.AppImage` or use the AUR
  package.
- o8's server needs Node 22 or 24 on `PATH` (`pacman -S nodejs` or mise).

## Window class

Every o8 window uses the class / app id `o8` (X11 `WM_CLASS` and Wayland
`app_id`), matching `StartupWMClass=o8` in the desktop entry. Check with
`hyprctl clients | grep -A3 'class: o8'`.

## Hyprland rules

Hyprland tiles every window. Keep the main window tiled and float o8's small
helper windows. Add to `~/.config/hypr/hyprland.conf` (Omarchy: an included
file such as `~/.config/hypr/windows.conf`):

```ini
# o8 helper windows float; the main "o8" window stays tiled
windowrule = float, class:^(o8)$, title:^(o8 (Voice Settings|dictation|is still working|needs to be reinstalled|remote preview|browser)|Chat voice)$
windowrule = center, class:^(o8)$, title:^(o8 Voice Settings|o8 is still working|o8 needs to be reinstalled)$
# overlays: no focus steal, no border
windowrule = float, class:^(o8)$, title:^o8 (pointer|spatial ink|agent partials)$
windowrule = nofocus, class:^(o8)$, title:^o8 (pointer|spatial ink|agent partials)$
windowrule = noborder, class:^(o8)$, title:^o8 (pointer|spatial ink|agent partials)$
# GTK file pickers opened by o8 (Add project, attachments)
windowrule = float, class:^(o8)$, title:^(Open|Open Folder|Select.*|Save.*)$

# Launch or focus o8 (Omarchy helper)
bind = SUPER SHIFT, O, exec, omarchy-launch-or-focus o8
```

Hyprland 0.48+ accepts `windowrule` with `class:`/`title:` fields; on older
versions use `windowrulev2` with the same fields. Newer Hyprland releases
may change rule syntax again; keep the `class:^(o8)$` match and the titles.

## Blank window on NVIDIA

On an NVIDIA + Wayland session o8 sets, before WebKitGTK starts,
`__NV_DISABLE_EXPLICIT_SYNC=1` and `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Any value
you already exported wins. Turn the defaults off with `O8_LINUX_GPU_DEFAULTS=0`.
If the window is still blank, try `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
