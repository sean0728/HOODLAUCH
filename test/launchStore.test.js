const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Plain Node/Mocha unit tests for lib/launchStore.js — no contracts, no
// chain, just filesystem behavior. Verifies the fix for the collision this
// module used to have: a token launched on one network could silently
// overwrite another network's file of the same ticker, because every
// network wrote into one shared deployed-contracts/ directory.
//
// DEPLOYED_CONTRACTS_DIR is read once at module load time, so each test
// points it at a fresh scratch directory and forces a clean re-require via
// the module cache rather than relying on any reset function.
describe("lib/launchStore.js (per-network deployed-contracts/ directories)", function () {
  let scratchDir;
  let launchStore;

  function freshLaunchStore(root) {
    process.env.DEPLOYED_CONTRACTS_DIR = root;
    delete require.cache[require.resolve("../lib/launchStore")];
    return require("../lib/launchStore");
  }

  function baseEntry(overrides) {
    return {
      name: "Aurora Ledger",
      symbol: "AURA",
      mode: "just",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      pairAddress: null,
      creator: "0x2222222222222222222222222222222222222222",
      totalSupply: "1000000000000000000000000000",
      deploymentTxHash: "0xabc",
      verified: false,
      proxyVerified: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "launchstore-test-"));
    launchStore = freshLaunchStore(scratchDir);
  });

  afterEach(function () {
    delete process.env.DEPLOYED_CONTRACTS_DIR;
    delete require.cache[require.resolve("../lib/launchStore")];
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("writes each network's launch into its own subdirectory", function () {
    launchStore.recordLaunch(baseEntry({ network: "robinhoodTestnet" }));
    launchStore.recordLaunch(baseEntry({ network: "robinhoodMainnet" }));

    expect(fs.existsSync(path.join(scratchDir, "robinhoodTestnet", "AURA.json"))).to.equal(true);
    expect(fs.existsSync(path.join(scratchDir, "robinhoodMainnet", "AURA.json"))).to.equal(true);
  });

  it("never lets a same-ticker launch on one network overwrite another network's record", function () {
    launchStore.recordLaunch(
      baseEntry({ network: "robinhoodTestnet", tokenAddress: "0xTESTNETTOKEN00000000000000000000000000" })
    );
    launchStore.recordLaunch(
      baseEntry({ network: "robinhoodMainnet", tokenAddress: "0xMAINNETTOKEN00000000000000000000000000" })
    );

    const testnetRecord = JSON.parse(fs.readFileSync(path.join(scratchDir, "robinhoodTestnet", "AURA.json"), "utf8"));
    const mainnetRecord = JSON.parse(fs.readFileSync(path.join(scratchDir, "robinhoodMainnet", "AURA.json"), "utf8"));

    expect(testnetRecord.tokenAddress).to.equal("0xTESTNETTOKEN00000000000000000000000000");
    expect(mainnetRecord.tokenAddress).to.equal("0xMAINNETTOKEN00000000000000000000000000");
  });

  it("keeps each network's JSON ledger and CSV mirror separate and append-only", function () {
    launchStore.recordLaunch(baseEntry({ network: "robinhoodTestnet", symbol: "ONE" }));
    launchStore.recordLaunch(baseEntry({ network: "robinhoodTestnet", symbol: "TWO" }));
    launchStore.recordLaunch(baseEntry({ network: "robinhoodMainnet", symbol: "ONE" }));

    expect(launchStore.readLedger("robinhoodTestnet")).to.have.lengthOf(2);
    expect(launchStore.readLedger("robinhoodMainnet")).to.have.lengthOf(1);

    const csv = fs.readFileSync(path.join(scratchDir, "robinhoodTestnet", "launched-tokens.csv"), "utf8");
    expect(csv.split("\n").filter(Boolean)).to.have.lengthOf(3); // header + 2 rows
  });

  it("readAllLedgers() combines every network, and listNetworks() reports them all", function () {
    launchStore.recordLaunch(baseEntry({ network: "robinhoodTestnet" }));
    launchStore.recordLaunch(baseEntry({ network: "robinhoodMainnet", symbol: "OTHER" }));
    launchStore.recordLaunch(baseEntry({ network: "hardhat", symbol: "LOCAL" }));

    expect(launchStore.listNetworks().sort()).to.deep.equal(["hardhat", "robinhoodMainnet", "robinhoodTestnet"].sort());
    expect(launchStore.readAllLedgers()).to.have.lengthOf(3);
  });

  it("reading a network with no launches yet returns an empty array rather than throwing", function () {
    expect(launchStore.readLedger("neverLaunchedHere")).to.deep.equal([]);
  });

  it("sanitizes an unsafe/missing network name into a safe directory segment instead of failing", function () {
    launchStore.recordLaunch(baseEntry({ network: "../../etc" }));
    const dirs = fs.readdirSync(scratchDir);
    expect(dirs).to.have.lengthOf(1);
    expect(dirs[0]).to.not.include("..");
    expect(dirs[0]).to.not.include("/");
  });
});
