// Platform helpers shared by every packaging entry point.
//
// Upstream Octopus packages exclusively for macOS: it signs with ad-hoc
// codesign, strips with the Darwin `strip -x` flag and copies through APFS
// clonefile. None of those exist on Linux or Windows. This module is the single
// place that knows which of them a build may use, so no caller has to repeat a
// `process.platform` test and silently skip a step.

const { spawnSync } = require("node:child_process");

const isDarwin = () => process.platform === "darwin";
const isWindows = () => process.platform === "win32";
const isLinux = () => process.platform === "linux";

function commandExists(command) {
  const probe = spawnSync(command, isWindows() ? ["/?"] : ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status !== null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout;
}

// `strip -x` is the Darwin form. GNU strip uses `--strip-unneeded`; binutils'
// `strip` is absent from most Windows toolchains, where the linker already
// discards what it can.
function stripExecutable(file) {
  if (isDarwin()) return run("strip", ["-x", file]);
  if (isLinux()) return run("strip", ["--strip-unneeded", file]);
}

// Ad-hoc signing is a macOS concept. On Linux and Windows there is nothing to
// sign, so the receipt records "unsigned" instead of pretending a signature was
// verified.
function signAdHoc(file) {
  if (!isDarwin()) return "unsigned";
  run("codesign", ["--force", "--sign", "-", file]);
  return "ad-hoc";
}

function verifySignature(file) {
  if (!isDarwin()) return "unsigned";
  run("codesign", ["--verify", "--strict", file]);
  return "ad-hoc";
}

module.exports = {
  isDarwin,
  isLinux,
  isWindows,
  commandExists,
  run,
  stripExecutable,
  signAdHoc,
  verifySignature,
};
