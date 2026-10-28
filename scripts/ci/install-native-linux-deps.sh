#!/usr/bin/env bash
set -euo pipefail

packages=(libfontconfig1-dev libfreetype-dev libxkbcommon-dev libxkbcommon-x11-dev libxcb1-dev libx11-xcb-dev libvulkan-dev)
if [[ "${O8_NATIVE_HEADLESS_TESTS:-false}" != true ]]; then
  packages+=(mesa-vulkan-drivers xvfb xauth x11-xserver-utils imagemagick fonts-dejavu-core xdotool tesseract-ocr)
fi
missing=()
for package in "${packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then
    missing+=("$package")
  fi
done
if (( ${#missing[@]} )); then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo 'Native prerequisites already installed; no package download needed.'
fi
