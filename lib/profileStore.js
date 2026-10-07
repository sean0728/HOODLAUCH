// Storage for wallet profiles (see lib/profile.js). Platform-wide, not per
// network: one profile per wallet address, same on testnet and mainnet.
//   fs   : <RELAYER_DATA_ROOT>/profiles.json   { [addressLower]: record }
//   MySQL: profiles table (created by lib/db.js ensureSchema)
// record = { address, name, nameKey, avatar (data URL | null), avatarV (ms
// timestamp that changes whenever the picture changes), createdAt, updatedAt }
// The list endpoint never includes `avatar` itself (pictures are served
// separately), so the list stays small.
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { RELAYER_DATA_ROOT } = require("./relayerStore");

const PROFILES_PATH = path.join(RELAYER_DATA_ROOT, "profiles.json");

function readAllFs() {
  try {
    if (!fs.existsSync(PROFILES_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    console.warn(`profiles.json could not be read (${err.message}) — treating it as empty.`);
    return {};
  }
}
function writeAllFs(all) {
  fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(all));
}

function rowToRecord(row) {
  return {
    address: row.address,
    name: row.name || "",
    nameKey: row.name_key || "",
    avatar: row.avatar || null,
    avatarV: row.avatar_v != null ? Number(row.avatar_v) : null,
    createdAt: row.created_at != null ? Number(row.created_at) : null,
    updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
  };
}

function lightRecord(r) {
  return { name: r.name || "", avatarV: r.avatar ? r.avatarV || 1 : null };
}

// { [addressLower]: { name, avatarV } } — only wallets that have a name or a picture.
async function listProfiles() {
  const out = {};
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT address, name, name_key, (avatar IS NOT NULL) AS has_avatar, avatar_v FROM profiles");
    for (const r of rows) {
      out[r.address] = { name: r.name || "", avatarV: r.has_avatar ? Number(r.avatar_v) || 1 : null };
    }
    return out;
  }
  const all = readAllFs();
  for (const [addr, rec] of Object.entries(all)) out[addr] = lightRecord(rec);
  return out;
}

async function getProfile(address) {
  const key = String(address).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT * FROM profiles WHERE address = ?", [key]);
    return rows.length ? rowToRecord(rows[0]) : null;
  }
  return readAllFs()[key] || null;
}

async function nameOwner(nameKey, exceptAddress) {
  if (!nameKey) return null;
  const except = String(exceptAddress).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT address FROM profiles WHERE name_key = ? AND address <> ?", [nameKey, except]);
    return rows.length ? rows[0].address : null;
  }
  const all = readAllFs();
  for (const [addr, rec] of Object.entries(all)) if (addr !== except && rec.nameKey === nameKey) return addr;
  return null;
}

// Saves (creates or updates) a profile. `avatar`: undefined = keep the saved
// picture, null = remove it, string = new picture. Throws an Error with
// .code === "NAME_TAKEN" if another wallet already holds the name. A profile
// with no name and no picture is deleted.
async function saveProfile(address, { name, nameKey, avatar }) {
  const key = String(address).toLowerCase();
  const now = Date.now();
  if (await nameOwner(nameKey, key)) {
    const e = new Error("That name is already taken.");
    e.code = "NAME_TAKEN";
    throw e;
  }
  const existing = await getProfile(key);
  const nextAvatar = avatar === undefined ? (existing ? existing.avatar : null) : avatar;
  const avatarChanged = avatar !== undefined && (existing ? existing.avatar : null) !== avatar;
  const rec = {
    address: key,
    name: name || "",
    nameKey: nameKey || "",
    avatar: nextAvatar || null,
    avatarV: nextAvatar ? (avatarChanged || !existing || !existing.avatarV ? now : existing.avatarV) : null,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now,
  };
  if (!rec.name && !rec.avatar) {
    await deleteProfile(key);
    return null;
  }
  if (db.isDbConfigured()) {
    try {
      await db.query(
        `INSERT INTO profiles (address, name, name_key, avatar, avatar_v, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), name_key = VALUES(name_key), avatar = VALUES(avatar),
           avatar_v = VALUES(avatar_v), updated_at = VALUES(updated_at)`,
        [rec.address, rec.name, rec.nameKey || null, rec.avatar, rec.avatarV, rec.createdAt, rec.updatedAt]
      );
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        const e = new Error("That name is already taken.");
        e.code = "NAME_TAKEN";
        throw e;
      }
      throw err;
    }
  } else {
    const all = readAllFs();
    all[key] = rec;
    writeAllFs(all);
  }
  return rec;
}

async function deleteProfile(address) {
  const key = String(address).toLowerCase();
  if (db.isDbConfigured()) {
    const res = await db.query("DELETE FROM profiles WHERE address = ?", [key]);
    return !!(res && res.affectedRows);
  }
  const all = readAllFs();
  if (!all[key]) return false;
  delete all[key];
  writeAllFs(all);
  return true;
}

module.exports = { listProfiles, getProfile, saveProfile, deleteProfile };
