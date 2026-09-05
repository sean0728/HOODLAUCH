const { expect } = require("chai");
const { CONFIG_KEYS, canonicalizePlatformConfig, platformConfigMessage } = require("../lib/platformConfig");

// This module MUST stay byte-identical to index.html's own CONFIG_KEYS /
// canonicalizePlatformConfig / platformConfigMessage (see that file's own
// "kept in sync by hand" comment) — a signature an admin makes client-side
// only verifies server-side if both sides compute the exact same message
// string for the exact same input. These tests pin the exact shape/string
// this side produces so a future edit here can't silently drift from
// index.html's copy without a test failing first.
describe("lib/platformConfig.js", function () {
  describe("canonicalizePlatformConfig", function () {
    it("fills in every CONFIG_KEYS entry as {demo, live}, defaulting missing values to null", function () {
      const out = canonicalizePlatformConfig({});
      expect(Object.keys(out)).to.deep.equal(CONFIG_KEYS);
      for (const key of CONFIG_KEYS) {
        expect(out[key]).to.deep.equal({ demo: null, live: null });
      }
    });

    it("passes through provided demo/live values", function () {
      const out = canonicalizePlatformConfig({
        tokenFactory: { demo: "0xAAA", live: "0xBBB" },
        relayerApiUrl: { demo: "https://demo.example" },
      });
      expect(out.tokenFactory).to.deep.equal({ demo: "0xAAA", live: "0xBBB" });
      expect(out.relayerApiUrl).to.deep.equal({ demo: "https://demo.example", live: null });
      expect(out.customTokenFactory).to.deep.equal({ demo: null, live: null });
    });

    it("treats null/undefined/empty-string values as null (falsy defaulting), never as literal strings", function () {
      const out = canonicalizePlatformConfig({
        priceFeed: { demo: "", live: undefined },
      });
      expect(out.priceFeed).to.deep.equal({ demo: null, live: null });
    });

    it("handles a completely missing or null config object the same as an empty one", function () {
      expect(canonicalizePlatformConfig(null)).to.deep.equal(canonicalizePlatformConfig({}));
      expect(canonicalizePlatformConfig(undefined)).to.deep.equal(canonicalizePlatformConfig({}));
    });

    it("ignores keys not in CONFIG_KEYS rather than passing them through", function () {
      const out = canonicalizePlatformConfig({ notARealKey: { demo: "x", live: "y" } });
      expect(out).to.not.have.property("notARealKey");
    });
  });

  describe("platformConfigMessage", function () {
    it("embeds the canonicalized config JSON and the timestamp in the exact expected format", function () {
      const cfg = { tokenFactory: { demo: "0xAAA", live: null } };
      const timestamp = 1700000000000;
      const message = platformConfigMessage(cfg, timestamp);
      const expectedJson = JSON.stringify(canonicalizePlatformConfig(cfg));
      expect(message).to.equal(`Hood Launch admin: update platform config to ${expectedJson} at ${timestamp}`);
    });

    it("produces a different message for a different config — the signature can't be replayed to save something else", function () {
      const timestamp = 1700000000000;
      const messageA = platformConfigMessage({ tokenFactory: { demo: "0xAAA" } }, timestamp);
      const messageB = platformConfigMessage({ tokenFactory: { demo: "0xBBB" } }, timestamp);
      expect(messageA).to.not.equal(messageB);
    });

    it("produces a different message for a different timestamp, same config", function () {
      const cfg = { tokenFactory: { demo: "0xAAA" } };
      const messageA = platformConfigMessage(cfg, 111);
      const messageB = platformConfigMessage(cfg, 222);
      expect(messageA).to.not.equal(messageB);
    });
  });
});
