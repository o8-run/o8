#!/usr/bin/env bash
set -euo pipefail

packages=(libfontconfig1-dev libfreetype-dev libxkbcommon-dev libxkbcommon-x11-dev libxcb1-dev libx11-xcb-dev libvulkan-dev libwebkit2gtk-4.1-dev libgtk-3-dev dbus-daemon)
if [[ "${O8_NATIVE_HEADLESS_TESTS:-false}" != true ]]; then
  packages+=(mesa-vulkan-drivers xvfb xauth openbox x11-xserver-utils imagemagick fonts-dejavu-core xdotool tesseract-ocr)
fi
# The production-binary terminal test owns a private Xvfb/software Vulkan display.
# Keep the ordinary headless prerequisite contract unchanged unless opted in.
if [[ "${O8_NATIVE_REAL_WINDOW_TESTS:-false}" == true ]]; then
  packages+=(mesa-vulkan-drivers xvfb xauth openbox xdotool fonts-dejavu-core)
fi
missing=()
for package in "${packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then
    missing+=("$package")
  fi
done
# The runner's mirror list falls back to the next mirror only after a request
# fails. apt's default timeout lets one stalled mirror hold every package for
# minutes and run native shards into their job limit. Short timeouts with one
# retry move each request to the next mirror in about a minute; more retries
# keep hammering the stalled one.
apt_options=(-o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o Acquire::Retries=1)
if (( ${#missing[@]} )); then
  sudo apt-get "${apt_options[@]}" update -qq
  sudo apt-get "${apt_options[@]}" install -y --no-install-recommends "${missing[@]}"
else
  echo 'Native prerequisites already installed; no package download needed.'
fi
