// One-time, self-healing migration helper shared by launchStore.js,
// relayerStore.js, and deploymentStore.js.
//
// Those three modules used to default to writing at the project root
// (deployed-contracts/, relayer-data/, deployments/) and now default to
// public/assets/... instead, so that data survives a GoDaddy redeploy (see
// the comments where each ROOT constant is defined). That path change is
// invisible to anyone who already has real data sitting at the old
// location — without this, the app would just start reading an empty
// directory at the new path and every previously launched token, voucher,
// and cursor would look like it had disappeared, even though the old files
// are still sitting right there on disk.
//
// This runs once per process start (called from each store module right
// after it computes its ROOT constant) and moves the legacy directory into
// the new location the first time it sees it — after that, the new
// location has content, so every later boot is a no-op. It never runs at
// all when DEPLOYED_CONTRACTS_DIR/RELAYER_DATA_DIR/DEPLOYMENTS_DIR is set,
// since that means someone has deliberately pointed this at a real
// persistent volume and the legacy top-level path is irrelevant.
const fs = require("fs");
const path = require("path");

function copyDirRecursiveSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursiveSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

/**
 * If `legacyDir` exists and `newDir` doesn't yet have any content, moves
 * `legacyDir` to `newDir` (rename when possible, copy-then-delete as a
 * fallback if they're ever on different filesystems). If `newDir` already
 * has content, does nothing — that means either this already ran on a
 * previous boot, or the new location is genuinely in active use, and
 * either way silently overwriting it would be the wrong call.
 *
 * Never throws: a failed migration is logged as a warning so the app still
 * starts, rather than crashing the whole process over a one-time cleanup
 * step. Worst case, the data just stays at the old location until someone
 * looks at the warning and moves it by hand.
 */
function migrateLegacyDataDir(legacyDir, newDir) {
  try {
    if (!fs.existsSync(legacyDir)) return; // nothing to migrate

    const newHasContent = fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0;
    if (newHasContent) return; // already migrated, or already in real use — don't touch it

    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    if (fs.existsSync(newDir)) {
      // mkdirSync({recursive:true}) or an earlier empty ensureDir() call may
      // have already created an empty newDir — clear it so rename doesn't
      // fail with ENOTEMPTY/EEXIST.
      fs.rmSync(newDir, { recursive: true, force: true });
    }

    try {
      fs.renameSync(legacyDir, newDir);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      copyDirRecursiveSync(legacyDir, newDir);
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }

    console.log(`[migrateLegacyDataDir] Moved existing data from ${legacyDir} to ${newDir}`);
  } catch (err) {
    console.warn(
      `[migrateLegacyDataDir] Could not auto-migrate ${legacyDir} -> ${newDir} (${err.message}). ` +
        `If you have existing data at the old location, move it to ${newDir} by hand.`
    );
  }
}

module.exports = { migrateLegacyDataDir };
