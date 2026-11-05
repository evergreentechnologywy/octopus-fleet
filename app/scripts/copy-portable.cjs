// Portable package copy.
//
// macOS packaging copies through APFS clonefile (copy-macos.cjs) because it is
// instant and preserves modes exactly. Linux and Windows have no clonefile, so
// the same entry list is applied with ordinary filesystem calls. The entry list
// is produced by copy-macos.cjs; only the application of it differs, which is
// why the two modules share one shape.

const fs = require("node:fs");
const path = require("node:path");

function applyEntries(entries) {
  for (const entry of entries) {
    if (entry.type === "directory") {
      fs.mkdirSync(entry.destination, { recursive: true });
      // The macOS path gets the mode from clonefile; replicate it so a packaged
      // tree has identical permissions on every platform.
      try { fs.chmodSync(entry.destination, entry.mode); } catch { /* best effort */ }
      continue;
    }
    if (entry.type === "symlink") {
      fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
      try { fs.unlinkSync(entry.destination); } catch { /* nothing to replace */ }
      fs.symlinkSync(entry.target, entry.destination);
      continue;
    }
    if (entry.type !== "file") throw new Error(`Unsupported package entry: ${entry.type}`);
    fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
    fs.copyFileSync(entry.source, entry.destination);
    // Executability is load-bearing: the packager's layout validator rejects a
    // bundled binary that is not runnable, and copyFileSync would otherwise
    // create it 0644.
    try { fs.chmodSync(entry.destination, fs.statSync(entry.source).mode & 0o777); } catch { /* best effort */ }
  }
}

module.exports = { applyEntries };
