FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
# Runtime/capture prerequisites only. No o8 installer or Vulkan ICD is installed.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    xvfb xauth x11-utils x11-xserver-utils imagemagick fonts-dejavu-core \
    libgcc-s1 libstdc++6 libx11-6 libxcb1 libxkbcommon0 libxkbcommon-x11-0 \
    libvulkan1 vulkan-tools libfontconfig1 libfreetype6 libasound2 util-linux \
    dbus-daemon libwebkit2gtk-4.1-0 libgtk-3-0 \
    && test "$(dpkg-query -W -f='${Status}' mesa-vulkan-drivers 2>/dev/null || true)" != 'install ok installed' \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
