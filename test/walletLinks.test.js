const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("hardhat");

// Linked wallets: a Solana wallet linked to an account (a Robinhood wallet) inherits the account's name, and can
// comment / call out under it. These tests cover the pieces that don't need a running relayer: the signed-message
// formats (shared with the page), the link store, and the Solana signature check the link route relies on. The
// routes themselves are exercised end to end against a real relayer in the browser check.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function newSolanaKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { address: b58encode(raw), sign: (msg) => b58encode(crypto.sign(null, Buffer.from(msg, "utf8"), privateKey)) };
}

describe("Linked wallets", function () {
  describe("signed messages (lib/social.js)", function () {
    const social = require("../lib/social");

    it("keeps the existing EVM message formats byte-for-byte (lowercased addresses)", function () {
      const token = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
      const who = "0x9965507D1a55bcc2695C58ba16FB37d819B0A4dc";
      expect(social.commentMessage(token, who, "gm", 123))
        .to.equal(`Hood Launch: comment on ${token.toLowerCase()} as ${who.toLowerCase()}: "gm" at 123`);
      expect(social.calloutMessage(token, who, "", 5))
        .to.equal(`Hood Launch: call out ${token.toLowerCase()} as ${who.toLowerCase()}: "" at 5`);
      expect(social.deleteCommentMessage("abcd", who, 9)).to.equal(`Hood Launch: delete comment abcd as ${who.toLowerCase()} at 9`);
    });

    it("leaves Solana addresses exactly as they are (base58 is case-sensitive)", function () {
      const kp = newSolanaKeypair();
      expect(social.canonId(kp.address)).to.equal(kp.address);
      const mint = "So11111111111111111111111111111111111111112";
      expect(social.commentMessage(mint, kp.address, "hi", 1)).to.equal(`Hood Launch: comment on ${mint} as ${kp.address}: "hi" at 1`);
    });

    it("builds the link / unlink messages with EVM addresses lowercased and Solana addresses untouched, whichever side is which", function () {
      const kp = newSolanaKeypair();
      const acct = "0x9965507D1a55bcc2695C58ba16FB37d819B0A4dc";
      expect(social.linkMessage(kp.address, acct, 77)).to.equal(`IgnitionX: link wallet ${kp.address} to account ${acct.toLowerCase()} at 77`);
      expect(social.unlinkMessage(kp.address, acct, 78)).to.equal(`IgnitionX: unlink wallet ${kp.address} from account ${acct.toLowerCase()} at 78`);
      // a Solana-first account: the main wallet is the Solana one, the linked wallet is the EVM one
      expect(social.linkMessage(acct, kp.address, 79)).to.equal(`IgnitionX: link wallet ${acct.toLowerCase()} to account ${kp.address} at 79`);
    });

    it("builds follow and profile messages that work for Solana accounts too", function () {
      const kp = newSolanaKeypair();
      const evm = "0x9965507D1a55bcc2695C58ba16FB37d819B0A4dc";
      expect(social.followMessage(true, evm, kp.address, 5)).to.equal(`Hood Launch: follow ${evm.toLowerCase()} as ${kp.address} at 5`);
      expect(social.followMessage(false, kp.address, evm, 6)).to.equal(`Hood Launch: unfollow ${kp.address} as ${evm.toLowerCase()} at 6`);
      const profile = require("../lib/profile");
      expect(profile.profileMessage(kp.address, "Sol Fan", "keep", 7)).to.equal(`Hood Launch: update profile for ${kp.address} name="Sol Fan" avatar=keep at 7`);
      expect(profile.profileMessage(evm, "Evm Fan", "none", 8)).to.equal(`Hood Launch: update profile for ${evm.toLowerCase()} name="Evm Fan" avatar=none at 8`);
    });
  });

  describe("both wallets must sign the same link message", function () {
    const social = require("../lib/social");
    const pub = require("../lib/solanaPublic");
    const { verifySignatureFrom } = require("../lib/signedMessage");

    it("accepts a genuine pair and rejects a wrong or swapped signature", async function () {
      const kp = newSolanaKeypair();
      const other = newSolanaKeypair();
      const evm = ethers.Wallet.createRandom();
      const msg = social.linkMessage(kp.address, evm.address, Date.now());
      const evmSig = await evm.signMessage(msg);
      expect(verifySignatureFrom(msg, evmSig, evm.address)).to.equal(true);
      expect(pub.verifyWalletSignature(kp.address, msg, kp.sign(msg))).to.equal(true);
      // someone else's Solana key can't vouch for this wallet
      expect(pub.verifyWalletSignature(kp.address, msg, other.sign(msg))).to.equal(false);
      // a signature over a different account's message doesn't link this one
      const other2 = social.linkMessage(kp.address, ethers.Wallet.createRandom().address, Date.now());
      expect(pub.verifyWalletSignature(kp.address, msg, kp.sign(other2))).to.equal(false);
      // the EVM signature isn't a Solana signature and vice versa
      expect(pub.verifyWalletSignature(kp.address, msg, evmSig)).to.equal(false);
      expect(verifySignatureFrom(msg, kp.sign(msg), evm.address)).to.equal(false);
    });
  });

  describe("walletLinkStore (file storage)", function () {
    let store, dir;
    before(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "walletlinks-"));
      process.env.RELAYER_DATA_DIR = dir;
      for (const m of ["../lib/relayerStore", "../lib/walletLinkStore", "../lib/db"]) delete require.cache[require.resolve(m)];
      store = require("../lib/walletLinkStore");
    });
    after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    const A = "0x1111111111111111111111111111111111111111";
    const B = "0x2222222222222222222222222222222222222222";

    it("links a wallet to an account, case-sensitively, and lists it", async function () {
      const kp = newSolanaKeypair();
      expect(await store.getOwner(kp.address)).to.equal(null);
      expect(await store.addLink(kp.address, A.toUpperCase().replace("0X", "0x"))).to.equal(true);
      expect(await store.getOwner(kp.address)).to.equal(A);
      // a different-case spelling of the base58 address is a different (unlinked) wallet
      expect(await store.getOwner(kp.address.toLowerCase() === kp.address ? kp.address.toUpperCase() : kp.address.toLowerCase())).to.equal(null);
      const list = await store.listForOwner(A);
      expect(list.map((w) => w.address)).to.deep.equal([kp.address]);
      expect((await store.listAll())[kp.address]).to.equal(A);
    });

    it("is idempotent for the same account and refuses another account", async function () {
      const kp = newSolanaKeypair();
      expect(await store.addLink(kp.address, A)).to.equal(true);
      expect(await store.addLink(kp.address, A)).to.equal(false);
      let err;
      try { await store.addLink(kp.address, B); } catch (e) { err = e; }
      expect(err && err.code).to.equal("LINKED_ELSEWHERE");
      expect(await store.getOwner(kp.address)).to.equal(A);
    });

    it("unlinking frees the wallet for another account", async function () {
      const kp = newSolanaKeypair();
      await store.addLink(kp.address, A);
      expect(await store.removeLink(kp.address)).to.equal(true);
      expect(await store.removeLink(kp.address)).to.equal(false);
      expect(await store.getOwner(kp.address)).to.equal(null);
      expect(await store.addLink(kp.address, B)).to.equal(true);
      expect(await store.getOwner(kp.address)).to.equal(B);
    });
  });

  describe("profile and follow stores accept Solana accounts", function () {
    let profiles, follows, dir;
    before(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "solacct-"));
      process.env.RELAYER_DATA_DIR = dir;
      for (const m of ["../lib/relayerStore", "../lib/profileStore", "../lib/followStore", "../lib/db"]) delete require.cache[require.resolve(m)];
      profiles = require("../lib/profileStore");
      follows = require("../lib/followStore");
    });
    after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it("saves a profile under a Solana address exactly as given and finds it again", async function () {
      const kp = newSolanaKeypair();
      await profiles.saveProfile(kp.address, { name: "Sol Native", nameKey: "solnative" });
      const rec = await profiles.getProfile(kp.address);
      expect(rec.address).to.equal(kp.address);
      expect(rec.name).to.equal("Sol Native");
      expect((await profiles.listProfiles())[kp.address].name).to.equal("Sol Native");
      // the same name can't be taken by an EVM account
      let err;
      try { await profiles.saveProfile("0x1111111111111111111111111111111111111111", { name: "sol native", nameKey: "solnative" }); } catch (e) { err = e; }
      expect(err && err.code).to.equal("NAME_TAKEN");
    });

    it("follows work between Solana and EVM accounts in both directions", async function () {
      const kp = newSolanaKeypair();
      const evm = "0x2222222222222222222222222222222222222222";
      await follows.setFollow(kp.address, evm.toUpperCase().replace("0X", "0x"), true);
      await follows.setFollow(evm, kp.address, true);
      expect(await follows.getFollowing(kp.address)).to.deep.equal([evm]);
      expect(await follows.getFollowers(kp.address)).to.deep.equal([evm]);
      expect(await follows.setFollow(kp.address, evm, false)).to.equal(true);
      expect(await follows.getFollowing(kp.address)).to.deep.equal([]);
    });
  });

  describe("comment / callout stores keep Solana mints as they are", function () {
    let comments, callouts, dir;
    before(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "solsocial-"));
      process.env.RELAYER_DATA_DIR = dir;
      for (const m of ["../lib/relayerStore", "../lib/commentStore", "../lib/calloutStore", "../lib/db"]) delete require.cache[require.resolve(m)];
      comments = require("../lib/commentStore");
      callouts = require("../lib/calloutStore");
    });
    after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    const acct = "0x1111111111111111111111111111111111111111";

    it("stores and finds a comment on a mixed-case mint", async function () {
      const mint = newSolanaKeypair().address;
      expect(mint).to.not.equal(mint.toLowerCase()); // (a random base58 key has capitals with overwhelming probability)
      await comments.addComment("net", { token: mint, author: acct.toUpperCase().replace("0X", "0x"), text: "to the moon" });
      const rows = await comments.listComments("net", { token: mint });
      expect(rows).to.have.length(1);
      expect(rows[0].token).to.equal(mint);
      expect(rows[0].author).to.equal(acct);
    });

    it("keeps one callout per account per mint and returns the mint untouched", async function () {
      const mint = newSolanaKeypair().address;
      await callouts.addCallout("net", { token: mint, caller: acct, reason: "", priceAtCall: 0.0000012, mcapAtCall: null });
      const pair = await callouts.getForPair("net", acct, mint);
      expect(pair && pair.token).to.equal(mint);
      const live = await callouts.listCallouts("net", { token: mint });
      expect(live).to.have.length(1);
      expect(live[0].priceAtCall).to.equal(0.0000012);
    });
  });
});
