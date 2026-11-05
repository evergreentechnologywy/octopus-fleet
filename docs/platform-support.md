# Platform support

Upstream Octopus packages and runs on macOS 14+ only. This fork adds Linux and
Windows. This file records what was ported, what was verified, and what still
blocks a Windows runtime.

## Verified on Linux x64

Host: Node 24.22.1 (pinned headers), Rust 1.99.1 stable, gcc, OpenSSL 3.0.13
dev headers.

| Step | Result |
| --- | --- |
| `cargo check --workspace --all-targets` | passes unchanged — the kernel was never the blocker |
| `cargo build --release` (all bundled bins) | passes |
| `app/native/filesystem.c` → `octopus-filesystem.node` | compiles with `cc -fPIC -shared` |
| Codex `linux-x64` archive | downloads, SHA-256 matches the pin, `--version` reports `codex-cli 0.166.0`, regenerates the pinned protocol schemas byte-identically |
| `npm run build:cli -- --runtime` | produces a complete runtime distribution, 10 binaries |
| `octopus --help` | full command surface |
| `octopus up` | phase `ready` on a unix control socket, writable storage, 0 interface failures |
| `octopus setup --non-interactive --pack tokenbroker` | completes against the in-house gateway, no ChatGPT account |

Deployed and running under systemd on `hub` (`/opt/octopus`) and
`powerstation-wsl` (`/opt/octopus`), unit `octopus-runtime.service`.

## What the port changed

| File | Change |
| --- | --- |
| `app/scripts/platform-tools.cjs` (new) | single source of truth for which of codesign / strip / clonefile a build may use |
| `app/scripts/copy-portable.cjs` (new) | applies the existing copy-entry list with ordinary filesystem calls, preserving modes |
| `app/scripts/copy-macos.cjs` | dispatches to the portable path off darwin; macOS keeps APFS clonefile |
| `app/scripts/runtime-package.cjs` | strip only where a strip exists; skip ad-hoc signing off macOS, keep the symlink-escape inventory; record the signing mode actually used |
| `app/scripts/build-cli.cjs` | dropped the darwin-only throw; the Swift desktop-GUI substrate builds on macOS only and is skipped elsewhere, so the desktop_session driver reports itself unavailable instead of failing the build |
| `app/native/build.cjs`, `filesystem.c` | compile the addon on Linux (`cc -fPIC -shared`) and Windows (`clang-cl` or mingw); the two Darwin syscalls it wraps have no equivalent elsewhere, so off Darwin the module exports the same surface and answers `EOPNOTSUPP` |
| `app/native/runtime.json`, `runtime.cjs` | pin the Electron 45.2.1 archives for `linux-x64` and `win32-x64` |
| `managed-cli/release.json` | pin Codex 0.166.0 for `linux-x64` (musl) and `win32-x64` (msvc), both verified by SHA-256 and byte size |
| `managed-cli/bootstrap.cjs` | platform→archive-entry mapping in one table; `COPYFILE_FICLONE` only on darwin; the receipt vocabulary is two-valued (null or ad-hoc) so off macOS the seal keeps null and records the post-build digest |
| `app/electron/localPackages.cjs` | package bodies copy with `fs.copyFile` off macOS; the isolation contract asserted four lines later (own inode, nlink 1, mode set explicitly) is unchanged |
| `app/distribution/local-packages/packs/tokenbroker.json` (new) | an Application Pack whose Home provider is `world_provider_custom`, so a Home can be created on the in-house gateway instead of a ChatGPT subscription |

## Windows: cross-build works, runtime does not start yet

`cargo zigbuild --release --target x86_64-pc-windows-gnu` produces 21 PE32+
artifacts, including `octopus.exe` (19,023,872 bytes) — the kernel itself — from
unmodified source. Toolchain: `cargo-zigbuild` + `zig` in `/opt/toolchains`,
target added with `rustup target add x86_64-pc-windows-gnu`.

The kernel does not **run** yet. One blocker:

**The control socket is a Unix domain socket.** `RuntimeControl` holds a
`tokio::net::UnixListener` (`crates/octopus-app/src/runtime_control.rs:67`) and
`answer()` authorises each peer with `stream.peer_cred().uid()` (SO_PEERCRED),
which has no Windows equivalent. The client refuses anything that is not a
`unix://` endpoint (`app/cli/environment.cjs:84`).

A correct port needs, in order:

1. A `ControlStream` enum over `UnixStream` and
   `tokio::net::windows::named_pipe::NamedPipeServer`, with `AsyncRead` +
   `AsyncWrite` forwarding to the active variant, so `answer()` keeps one body.
2. A Windows authorisation check to replace `peer_cred().uid()`. Named pipes
   carry their own ACL and support impersonation; the check must be equivalent
   in strength, not a no-op, because this socket can stop and restart the
   runtime.
3. `socket_path()` returning a `\\.\pipe\...` name on Windows, and the client
   accepting that endpoint form.

Do not stub step 2. A named-pipe control socket that skips authorisation is
strictly worse than the Unix socket it replaces.

The native addon also cannot be cross-compiled: `x86_64-w64-mingw32-gcc` has no
`fstatat` / `AT_SYMLINK_NOFOLLOW`, and Node ships no import library for mingw
(only `node.lib` for MSVC). Build it on a Windows host with MSVC, or accept
that `cloneFile` / `renameDirectoryExclusive` answer `EOPNOTSUPP` — the only
consumer, `app/electron/nativeFiles.cjs`, already refuses to call them off
darwin, and `app/electron/localPackages.cjs` no longer uses the clone path off
macOS.

## Producing a Windows runtime distribution

Run on the Windows host, in the repo root, with Node 24 on `PATH`:

```sh
node app/native/runtime.cjs headers          # fetches the pinned 24.22.1 headers
npm ci --prefix app
set OCTOPUS_NATIVE_NODE_HEADERS=<path printed above>
npm run build:cli -- --runtime
```

`materialize` selects its platform from `process.platform`, so the `win32-x64`
Codex asset pinned in `release.json` is used automatically. `tar.exe` must exist
— Windows 10 1803+ ships it at `C:\Windows\System32\tar.exe`.

## Home setup on a gateway: one gate still hardcodes an account

`app/cli/setup.cjs:383` writes `provider: { interface_id, required_state:
"account_readable" }` into every setup plan, and the plan schema requires that
constant. Setup then runs the provider's `probeAccount` / `signIn` client hooks
(`app/electron/clientProviderMetadata.cjs:103-104`), which
`world_provider_custom` does not implement, so a Home on an
environment-credentialed gateway stops at:

    Provider 'world_provider_custom' does not support desktop account setup.

This is not a Linux or Windows problem — it reproduces on the original macOS
path. Finishing it needs a third `required_state` (credentials supplied by the
environment, no account to read) plus a skip in the step runner, and that
constant is currently a single-value enum in the schema, so the change is
deliberate rather than a one-line edit.

Everything up to that point works on Linux: the runtime boots, the pack loads,
the plan compiles with the right provider and 14 packages, and package
installation completes.
