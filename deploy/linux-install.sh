#!/bin/sh
# Install the Octopus runtime on a Linux node.
#
# Idempotent: re-running repairs rather than duplicates. Verified on the hub
# (Debian/Ubuntu) and on powerstation's WSL2 instance.
#
#   sudo sh deploy/linux-install.sh [install-root]
#
# What it does NOT do: implement a Linux process-authority backend. Until that
# lands, the runtime boots, installs packages and seals setup, then every
# interface goes into a coma (see docs/platform-support.md). The script is the
# deployment half; it is not a claim that the runtime works.
set -eu

ROOT="${1:-/opt/octopus}"
REPO_URL="${OCTOPUS_REPO_URL:-https://github.com/evergreentechnologywy/octopus-fleet.git}"
BRANCH="${OCTOPUS_BRANCH:-port/linux-windows}"
NODE_VERSION="${OCTOPUS_NODE_VERSION:-24.15.0}"

log() { printf '%s\n' "== $*"; }

log "system packages"
export DEBIAN_FRONTEND=noninteractive
# bubblewrap and zsh are runtime dependencies, not build conveniences: the
# workspace environment door execs zsh, and bubblewrap is the primitive the
# Linux process-authority backend will be built on.
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl git build-essential pkg-config libssl-dev \
  bubblewrap zsh tar xz-utils

log "node ${NODE_VERSION}"
mkdir -p /opt/toolchains
if [ ! -x "/opt/toolchains/node24/bin/node" ]; then
  curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node24.tar.xz
  tar -xf /tmp/node24.tar.xz -C /opt/toolchains
  mv "/opt/toolchains/node-v${NODE_VERSION}-linux-x64" /opt/toolchains/node24
  rm -f /tmp/node24.tar.xz
fi

log "rust"
if [ ! -x /opt/toolchains/cargo/bin/cargo ]; then
  curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh
  RUSTUP_HOME=/opt/toolchains/rustup CARGO_HOME=/opt/toolchains/cargo \
    sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain stable
fi
# A rustup install without a default toolchain leaves `cargo` present but
# unrunnable ("could not choose a version of cargo to run"). Seen on a node with
# a partial install, so the default is asserted every run rather than assumed
# from the binary's presence.
RUSTUP_HOME=/opt/toolchains/rustup CARGO_HOME=/opt/toolchains/cargo \
  /opt/toolchains/cargo/bin/rustup default stable >/dev/null

log "checkout ${BRANCH}"
mkdir -p "$ROOT"
if [ -d "$ROOT/repo/.git" ]; then
  git -C "$ROOT/repo" fetch origin "$BRANCH"
  git -C "$ROOT/repo" checkout "$BRANCH"
  git -C "$ROOT/repo" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$ROOT/repo"
fi

log "build"
cd "$ROOT/repo/app"
PATH="/opt/toolchains/node24/bin:/opt/toolchains/cargo/bin:$PATH" npm ci --no-audit --no-fund
PATH="/opt/toolchains/node24/bin:$PATH" node native/runtime.cjs headers > "$ROOT/.node-headers-path" 2>/dev/null || true
if [ -s "$ROOT/.node-headers-path" ]; then
  export OCTOPUS_NATIVE_NODE_HEADERS="$(cat "$ROOT/.node-headers-path")"
fi
PATH="/opt/toolchains/node24/bin:/opt/toolchains/cargo/bin:$PATH" \
  OCTOPUS_NATIVE_NODE_HEADERS="${OCTOPUS_NATIVE_NODE_HEADERS:-}" \
  npm run build:cli -- --runtime

log "launcher"
cat > "$ROOT/octopus" <<'LAUNCHER'
#!/bin/sh
set -eu
OCTOPUS_ROOT="${OCTOPUS_ROOT:-/opt/octopus}"
exec "${OCTOPUS_NODE:-/opt/toolchains/node24/bin/node}" "$OCTOPUS_ROOT/repo/app/cli/index.cjs" "$@"
LAUNCHER
chmod 0755 "$ROOT/octopus"
ln -sfn "$ROOT/octopus" /usr/local/bin/octopus

log "systemd"
cat > /etc/systemd/system/octopus-runtime.service <<UNIT
[Unit]
Description=Octopus Superintelligence OS runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=OCTOPUS_HOME=${ROOT}/home
Environment=OCTOPUS_ROOT=${ROOT}
Environment=PATH=/opt/toolchains/node24/bin:/usr/local/bin:/usr/bin:/bin
# The kernel binary is the long-lived process. \`octopus up\` on the Node client
# only hands off to it and exits, which would make systemd consider the service
# finished and run ExecStop immediately.
ExecStart=${ROOT}/repo/app/build/cli/runtime/bin/octopus up
ExecStop=${ROOT}/repo/app/build/cli/runtime/bin/octopus down
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
RestartSec=10
WorkingDirectory=${ROOT}
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now octopus-runtime.service

log "verify"
sleep 15
systemctl is-active octopus-runtime.service
OCTOPUS_HOME="$ROOT/home" /opt/toolchains/node24/bin/node "$ROOT/repo/app/cli/index.cjs" status || true
