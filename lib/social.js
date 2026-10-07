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
  return `Hood Launch: comment on ${String(tokenAddress).toLowerCase()} as ${String(author).toLowerCase()}: ${JSON.stringify(text)} at ${timestamp}`;
}
function deleteCommentMessage(id, requester, timestamp) {
  return `Hood Launch: delete comment ${id} as ${String(requester).toLowerCase()} at ${timestamp}`;
}
// An optional short reason for a callout: empty is fine, otherwise same rules as a comment.
function validateReason(text) {
  if (typeof text !== "string") return "Reason must be text.";
  if (text === "") return null;
  return validateComment(text);
}
function calloutMessage(tokenAddress, caller, reason, timestamp) {
  return `Hood Launch: call out ${String(tokenAddress).toLowerCase()} as ${String(caller).toLowerCase()}: ${JSON.stringify(reason)} at ${timestamp}`;
}
function deleteCalloutMessage(id, requester, timestamp) {
  return `Hood Launch: delete callout ${id} as ${String(requester).toLowerCase()} at ${timestamp}`;
}
function followMessage(follow, followee, follower, timestamp) {
  return `Hood Launch: ${follow ? "follow" : "unfollow"} ${String(followee).toLowerCase()} as ${String(follower).toLowerCase()} at ${timestamp}`;
}

module.exports = {
  COMMENT_MAX, MAX_FOLLOWING, normalizeComment, validateComment, commentMessage, deleteCommentMessage, followMessage,
  validateReason, calloutMessage, deleteCalloutMessage,
};
