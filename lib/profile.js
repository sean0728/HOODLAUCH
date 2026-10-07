// Wallet profiles (a display name and a picture per wallet): validation and
// the signed-message format. index.html has a mirror of normalizeName /
// validateName / profileMessage — keep the two byte-identical, or a profile
// save will fail to verify (the safe direction: never accepts a mismatch).
//
// A profile save is authorized by a personal_sign signature from the wallet
// itself (no admin involved), over a message that embeds the exact name and a
// hash of the exact picture being saved, so a signature can't be replayed to
// save a different name/picture. The message also carries a timestamp, so
// lib/signedMessage.js's isFreshTimestamp bounds how long a captured
// signature stays usable.
const crypto = require("crypto");

const NAME_MIN = 2;
const NAME_MAX = 24;
const AVATAR_MAX_CHARS = 120000; // encoded data-URL length (~90KB of image)
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

// Names nobody but the platform admin may use.
const RESERVED_KEYS = ["admin", "administrator", "hoodlaunch", "hood", "official", "support", "team", "staff", "moderator", "mod", "robinhood", "system"];

// NFKC folds look-alike forms (full-width letters etc.), whitespace collapsed.
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

// The uniqueness key: case-insensitive and ignoring spaces/dots/dashes/
// underscores, so "Sean", "sean" and "S.e-an" can't all be claimed.
function nameKey(name) {
  return normalizeName(name).toLowerCase().replace(/[ ._-]/g, "");
}

// Returns an error message, or null when the name is acceptable. An empty
// name is valid (it means "no name set, show the wallet").
function validateName(name, { isAdmin = false } = {}) {
  if (typeof name !== "string") return "Name must be text.";
  if (name === "") return null;
  if (name !== normalizeName(name)) return "Name has extra spaces or unusual characters.";
  const len = Array.from(name).length;
  if (len < NAME_MIN || len > NAME_MAX) return `Name must be ${NAME_MIN}-${NAME_MAX} characters.`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) return "Use letters, numbers, spaces, dots, dashes or underscores (start with a letter or number).";
  const key = nameKey(name);
  if (/^0x[0-9a-f]*$/.test(key)) return "A name can't look like a wallet address.";
  if (!isAdmin && RESERVED_KEYS.includes(key)) return "That name is reserved.";
  return null;
}

function validateAvatar(avatar) {
  if (avatar == null) return null;
  if (typeof avatar !== "string" || !AVATAR_RE.test(avatar)) return "Picture must be a PNG, JPEG or WebP image.";
  if (avatar.length > AVATAR_MAX_CHARS) return "Picture is too large (max ~90KB after resizing).";
  return null;
}

function avatarHash(avatar) {
  return crypto.createHash("sha256").update(avatar).digest("hex");
}

// `avatarPart` is "keep" (leave the saved picture as is), "none" (remove it)
// or the sha256 hex of the new picture's data URL.
function profileMessage(address, name, avatarPart, timestamp) {
  return `Hood Launch: update profile for ${String(address).toLowerCase()} name=${JSON.stringify(name)} avatar=${avatarPart} at ${timestamp}`;
}

module.exports = { NAME_MIN, NAME_MAX, AVATAR_MAX_CHARS, normalizeName, nameKey, validateName, validateAvatar, avatarHash, profileMessage };
