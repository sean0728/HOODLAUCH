// Comments and follows: validation and the signed-message formats. index.html
// has a mirror of normalizeComment / validateComment / the message builders —
// keep them byte-identical, or a signed action will fail to verify (the safe
// direction: a mismatch is rejected, never accepted).
//
// Every action is authorized by a personal_sign signature from the acting
// wallet over a message that embeds exactly what is being done and a
// timestamp (lib/signedMessage.js isFreshTimestamp bounds replay).

const COMMENT_MAX = 280;
const MAX_FOLLOWING = 500;
const MAX_LINKED_WALLETS = 5; // wallets (of either chain) one account can have linked to it

// How an address appears inside a signed message and as a storage key. EVM addresses are
// case-insensitive, so they are lowercased (this is what every message always did). Solana
// addresses are base58 and CASE-SENSITIVE, so they must be left exactly as they are.
function canonId(a) {
  const s = String(a);
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s;
}

// Strips control characters and bidi-override characters (which can be used to
// disguise text), normalizes line endings, limits blank lines.
function normalizeComment(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Returns an error message, or null when the comment is acceptable.
function validateComment(text) {
  if (typeof text !== "string") return "Comment must be text.";
  if (text !== normalizeComment(text)) return "Comment contains unsupported characters.";
  const len = Array.from(text).length;
  if (len < 1) return "Write something first.";
  if (len > COMMENT_MAX) return `Comments are limited to ${COMMENT_MAX} characters.`;
  return null;
}

function commentMessage(tokenAddress, author, text, timestamp) {
  return `Hood Launch: comment on ${canonId(tokenAddress)} as ${canonId(author)}: ${JSON.stringify(text)} at ${timestamp}`;
}
function deleteCommentMessage(id, requester, timestamp) {
  return `Hood Launch: delete comment ${id} as ${canonId(requester)} at ${timestamp}`;
}
// An optional short reason for a callout: empty is fine, otherwise same rules as a comment.
function validateReason(text) {
  if (typeof text !== "string") return "Reason must be text.";
  if (text === "") return null;
  return validateComment(text);
}
function calloutMessage(tokenAddress, caller, reason, timestamp) {
  return `Hood Launch: call out ${canonId(tokenAddress)} as ${canonId(caller)}: ${JSON.stringify(reason)} at ${timestamp}`;
}
function deleteCalloutMessage(id, requester, timestamp) {
  return `Hood Launch: delete callout ${id} as ${canonId(requester)} at ${timestamp}`;
}
function followMessage(follow, followee, follower, timestamp) {
  return `Hood Launch: ${follow ? "follow" : "unfollow"} ${canonId(followee)} as ${canonId(follower)} at ${timestamp}`;
}

// Linking a wallet (either chain) to an account. BOTH wallets sign this exact text (each with its own chain's
// message signing: personal_sign for a Robinhood/EVM wallet, signMessage for a Solana wallet), so neither side can
// be linked without consent.
function linkMessage(wallet, account, timestamp) {
  return `IgnitionX: link wallet ${canonId(wallet)} to account ${canonId(account)} at ${timestamp}`;
}
// Unlinking is signed by the account's main wallet, or by the linked wallet itself.
function unlinkMessage(wallet, account, timestamp) {
  return `IgnitionX: unlink wallet ${canonId(wallet)} from account ${canonId(account)} at ${timestamp}`;
}

module.exports = {
  canonId, MAX_LINKED_WALLETS, linkMessage, unlinkMessage,
  COMMENT_MAX, MAX_FOLLOWING, normalizeComment, validateComment, commentMessage, deleteCommentMessage, followMessage,
  validateReason, calloutMessage, deleteCalloutMessage,
};
