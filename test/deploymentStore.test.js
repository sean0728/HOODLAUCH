const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Plain Node/Mocha unit tests for lib/deploymentStore.js — the per-network
// record of scripts/deploy.js's own output (TokenFactory/CustomTokenFactory
// addresses etc.), kept separate from the per-token deployed-contracts/
// ledger (see launchStore.test.js).
describe("lib/deploymentStore.js (per-network deployments/ directories)", function () {
  let scratchDir;
  let deploymentStore;

  function freshDeploymentStore(root) {
    process.env.DEPLOYMENTS_DIR = root;
    delete require.cache[require.resolve("../lib/deploymentStore")];
    return require("../lib/deploymentStore");
  }

  beforeEach(function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploymentstore-test-"));
    deploymentStore = freshDeploymentStore(scratchDir);
  });

  afterEach(function () {
    delete process.env.DEPLOYMENTS_DIR;
    delete require.cache[require.resolve("../lib/deploymentStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("writes a network's deployment into its own subdirectory, separate from other networks", function () {
    deploymentStore.recordDeployment("robinhoodTestnet", { tokenFactory: "0xTESTNET" });
    deploymentStore.recordDeployment("robinhoodMainnet", { tokenFactory: "0xMAINNET" });

    const testnetCurrent = deploymentStore.readCurrentDeployment("robinhoodTestnet");
    const mainnetCurrent = deploymentStore.readCurrentDeployment("robinhoodMainnet");

    expect(testnetCurrent.tokenFactory).to.equal("0xTESTNET");
    expect(mainnetCurrent.tokenFactory).to.equal("0xMAINNET");
    expect(fs.existsSync(path.join(scratchDir, "robinhoodTestnet", "current.json"))).to.equal(true);
    expect(fs.existsSync(path.join(scratchDir, "robinhoodMainnet", "current.json"))).to.equal(true);
  });

  it("overwrites current.json on each run but accumulates history.json", function () {
    deploymentStore.recordDeployment("robinhoodTestnet", { tokenFactory: "0xFIRST" });
    deploymentStore.recordDeployment("robinhoodTestnet", { tokenFactory: "0xSECOND" });

    const current = deploymentStore.readCurrentDeployment("robinhoodTestnet");
    expect(current.tokenFactory).to.equal("0xSECOND");

    const history = JSON.parse(fs.readFileSync(path.join(scratchDir, "robinhoodTestnet", "history.json"), "utf8"));
    expect(history).to.have.lengthOf(2);
    expect(history[0].tokenFactory).to.equal("0xFIRST");
    expect(history[1].tokenFactory).to.equal("0xSECOND");
  });

  it("returns null for a network that has never been deployed to, rather than throwing", function () {
    expect(deploymentStore.readCurrentDeployment("neverDeployedHere")).to.equal(null);
  });
});
