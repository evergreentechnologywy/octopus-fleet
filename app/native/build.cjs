const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyNodeHeaders } = require("./runtime.cjs");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.signal || result.status}`);
  return result.stdout.trim();
}

// Compile the NAPI client-filesystem addon for the host platform.
//
// macOS builds a Mach-O bundle against the Xcode clang in an SDK sysroot and
// ad-hoc signs it. Linux builds a shared object and Windows builds a .node DLL;
// neither platform has an ad-hoc signature to apply, so signing is skipped there
// rather than faked.
function buildClientFilesystem({ headers = process.env.OCTOPUS_NATIVE_NODE_HEADERS } = {}) {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    throw new Error(`Unsupported client filesystem platform: ${process.platform}`);
  }
  headers = verifyNodeHeaders(headers);
  if (!["arm64", "x64"].includes(process.arch)) throw new Error(`Unsupported client filesystem architecture: ${process.arch}`);
  const outputRoot = path.join(__dirname, "build");
  fs.mkdirSync(outputRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outputRoot, ".compile-"));
  const name = "octopus-filesystem.node";
  const source = path.join(__dirname, "filesystem.c");
  try {
    const output = path.join(stage, name);
    const common = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fvisibility=hidden", "-DNAPI_VERSION=8", "-I", headers];
    if (process.platform === "darwin") {
      const compiler = run("/usr/bin/xcrun", ["--find", "clang"]);
      const sdk = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
      run(compiler, [...common,
        "-mmacosx-version-min=14.0", "-arch", process.arch === "x64" ? "x86_64" : "arm64", "-isysroot", sdk,
        "-bundle", "-undefined", "dynamic_lookup", source, "-o", output]);
      run("/usr/bin/codesign", ["--force", "--sign", "-", output]);
    } else if (process.platform === "linux") {
      // cc resolves to the distro compiler; NAPI addons are ordinary shared
      // objects on ELF platforms, with no separate signing step.
      run("cc", [...common, "-fPIC", "-shared", source, "-o", output]);
    } else {
      // MinGW produces the DLL that Node loads as a .node addon. clang-cl is
      // preferred when a full MSVC toolchain is present.
      const compiler = ["clang-cl", "x86_64-w64-mingw32-gcc", "gcc"].find((candidate) => {
        const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
        return !probe.error && probe.status === 0;
      });
      if (!compiler) throw new Error("No Windows C compiler found (expected clang-cl or x86_64-w64-mingw32-gcc)");
      run(compiler, [...common, "-shared", source, "-o", output]);
    }
    const destination = path.join(outputRoot, name);
    fs.renameSync(output, destination);
    return destination;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { process.stdout.write(`${buildClientFilesystem()}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { buildClientFilesystem };
