const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

// lib/relayerStore.js scopes its data directory to whatever network the
// current Hardhat process is running against (it's always started via
// `npx hardhat run scripts/relayer.js --network <name>`, never invoked
// directly) — under `hardhat test` that network is "hardhat", which this
// test asserts against directly rather than trying to simulate switching
// networks mid-process (hre.network.name is fixed for the life of one
// Hardhat process, so real multi-network coverage lives in
// launchStore.test.js / deploymentStore.test.js instead, whose directory
// scoping doesn't depend on hre at all).
describe("lib/relayerStore.js (per-network relayer-data/ directory)", function () {
  let scratchDir;
  let relayerStore;

  function freshRelayerStore(root) {
    process.env.RELAYER_DATA_DIR = root;
    delete require.cache[require.resolve("../lib/relayerStore")];
    return require("../lib/relayerStore");
  }

  beforeEach(function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayerstore-test-"));
    relayerStore = freshRelayerStore(scratchDir);
  });

  afterEach(function () {
    delete process.env.RELAYER_DATA_DIR;
    delete require.cache[require.resolve("../lib/relayerStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("scopes its data directory under the root to the current Hardhat network", function () {
    expect(relayerStore.RELAYER_DATA_DIR).to.equal(path.join(scratchDir, "hardhat"));
  });

  it("writes vouchers and cursors under that per-network directory", function () {
    relayerStore.upsertVoucher("0xhash1", { status: "received" });
    relayerStore.setCursor("0xfactory", 12345);

    expect(fs.existsSync(path.join(scratchDir, "hardhat", "vouchers.json"))).to.equal(true);
    expect(fs.existsSync(path.join(scratchDir, "hardhat", "cursors.json"))).to.equal(true);
    expect(relayerStore.getVoucher("0xhash1").status).to.equal("received");
    expect(relayerStore.getCursor("0xfactory")).to.equal(12345);
  });
});
