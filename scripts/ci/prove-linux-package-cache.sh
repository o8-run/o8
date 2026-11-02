#!/usr/bin/env bash
set -euo pipefail
# Each invocation starts the same clean image. Only package payloads persist.
image='ubuntu@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c'
package_cache="${RUNNER_TEMP:?}/linux-package-cache-proof"
mkdir -p "$package_cache"
node_binary="$(command -v node)"
docker run --rm \
  --env "ImageOS=${ImageOS:?}-container-24737cef17f4" \
  --env "ImageVersion=${ImageVersion:?}" \
  --env DEBIAN_FRONTEND=noninteractive --env GITHUB_OUTPUT=/receipt \
  --mount "type=bind,src=$node_binary,dst=/usr/local/bin/node,readonly" \
  --mount "type=bind,src=$PWD/scripts/ci,dst=/opt/ci,readonly" \
  --mount "type=bind,src=$package_cache,dst=/cache" \
  --mount "type=bind,src=$GITHUB_OUTPUT,dst=/receipt" \
  "$image" node /opt/ci/linux-package-prerequisites.mjs install --group=rust --cache=/cache
