// The deploy-time authorisation of the reward distributors as PlatformToken snapshotters
// (lib/platformTokenSnapshotters.js, used by V4deploy.js, deployPlatformToken.js and
// authorizePlatformTokenSnapshotters.js).
//   V4_TEST=1 hardhat test test/V4PlatformTokenAuthorize.test.js
const { ethers } = require("hardhat");
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { distributorTargets, platformTokenAddress, authoriseSnapshotters } = require("../lib/platformTokenSnapshotters");

const ETH = ethers.parseEther;
const quiet = () => {};

describe("PlatformToken snapshotter authorisation (deploy scripts)", function () {
  this.timeout(120000);
  let owner, other, hookStub, feeWallet;
  let pm, plat, v2, fee, rewards, tax, creator;
  const A = (c) => c.getAddress();

  beforeEach(async () => {
    [owner, other, hookStub, feeWallet] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    plat = await (await ethers.getContractFactory("PlatformToken")).deploy("Platform", "PLAT", ETH("1000000"), owner.address);
    v2 = await (await ethers.getContractFactory("V4MockV2Router")).deploy(await A(plat), ETH("1000"));
    fee = await (await ethers.getContractFactory("V4FeeWalletDistributor")).deploy(await A(pm), hookStub.address, owner.address, await A(v2), feeWallet.address);
    rewards = await (await ethers.getContractFactory("V4PlatformRewardsDistributor")).deploy(await A(pm), hookStub.address, owner.address, await A(v2));
    tax = await (await ethers.getContractFactory("V4PlatformTaxDistributor")).deploy(await A(v2), ethers.ZeroAddress, feeWallet.address);
    creator = await (await ethers.getContractFactory("V4CreatorRewardsDistributor")).deploy(await A(pm), hookStub.address, owner.address);
  });

  async function targets() {
    return [["V4FeeWalletDistributor", await A(fee)], ["V4PlatformRewardsDistributor", await A(rewards)], ["V4PlatformTaxDistributor", await A(tax)]];
  }

  it("authorises the fee-wallet, platform-rewards and platform-tax distributors, and not the creator-rewards one", async () => {
    const r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(plat), targets: await targets(), log: quiet });
    expect(r.reason).to.equal(null);
    expect(r.authorised.map((x) => x[0])).to.deep.equal(["V4FeeWalletDistributor", "V4PlatformRewardsDistributor", "V4PlatformTaxDistributor"]);
    for (const c of [fee, rewards, tax]) expect(await plat.isSnapshotter(await A(c))).to.equal(true);
    expect(await plat.isSnapshotter(await A(creator))).to.equal(false);
  });

  it("is idempotent: a second run sends nothing", async () => {
    await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(plat), targets: await targets(), log: quiet });
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    const r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(plat), targets: await targets(), log: quiet });
    expect(r.authorised).to.have.length(0);
    expect(r.already).to.have.length(3);
    expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
  });

  it("after it, setPlatformToken works on the distributors (and refused before)", async () => {
    await expect(rewards.setPlatformToken(await A(plat))).to.be.revertedWith("V4PlatformTokenRewards: token owner must authorise this contract as a snapshotter first");
    await expect(tax.setPlatformToken(await A(plat))).to.be.revertedWith("V4PlatformTaxDistributor: token owner must authorise this contract as a snapshotter first");
    await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(plat), targets: await targets(), log: quiet });
    await rewards.setPlatformToken(await A(plat));
    await tax.setPlatformToken(await A(plat));
    await fee.setPlatformToken(await A(plat));
    expect(await rewards.platformToken()).to.equal(await A(plat));
    expect(await tax.platformToken()).to.equal(await A(plat));
  });

  it("a signer that is not the token's owner changes nothing and gets the reason instead of an error", async () => {
    const r = await authoriseSnapshotters({ ethers, signer: other, tokenAddress: await A(plat), targets: await targets(), log: quiet });
    expect(r.reason).to.match(/is not the token's owner/);
    expect(r.authorised).to.have.length(0);
    expect(await plat.isSnapshotter(await A(rewards))).to.equal(false);
  });

  it("an address with no contract is skipped, the rest are authorised", async () => {
    const t = [["Ghost", ethers.Wallet.createRandom().address], ...(await targets())];
    const r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(plat), targets: t, log: quiet });
    expect(r.skipped.map((x) => x[0])).to.deep.equal(["Ghost"]);
    expect(r.authorised).to.have.length(3);
  });

  it("a token address that is not the current PlatformToken is reported, not authorised", async () => {
    const legacy = await (await ethers.getContractFactory("V4MockLegacyPlatformToken")).deploy(ETH("1000"));
    let r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: await A(legacy), targets: await targets(), log: quiet });
    expect(r.reason).to.match(/not a PlatformToken/);
    r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: owner.address, targets: await targets(), log: quiet });
    expect(r.reason).to.match(/no contract/);
    r = await authoriseSnapshotters({ ethers, signer: owner, tokenAddress: null, targets: await targets(), log: quiet });
    expect(r.reason).to.match(/no platform token address/);
  });

  describe("reading the deployment files", () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hl-deploy-")); fs.mkdirSync(path.join(root, "deployments", "net1"), { recursive: true }); });
    const write = (name, obj) => fs.writeFileSync(path.join(root, "deployments", "net1", name), JSON.stringify(obj));

    it("takes the distributors from v4-deploy.json (top level, then its summary), environment settings first", () => {
      write("v4-deploy.json", { feeWalletDistributor: "0x1", platformRewardsDistributor: "0x2", summary: { platformTaxDistributor: "0x3", platformRewardsDistributor: "0xold" } });
      expect(distributorTargets("net1", {}, root)).to.deep.equal([["V4FeeWalletDistributor", "0x1"], ["V4PlatformRewardsDistributor", "0x2"], ["V4PlatformTaxDistributor", "0x3"]]);
      expect(distributorTargets("net1", { V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS: "0x9" }, root)[1]).to.deep.equal(["V4PlatformRewardsDistributor", "0x9"]);
      expect(distributorTargets("nonet", {}, root)).to.deep.equal([]);
    });

    it("takes the token from PLATFORM_TOKEN_ADDRESS or platform-token.json", () => {
      expect(platformTokenAddress("net1", {}, root)).to.equal(null);
      write("platform-token.json", { address: "0xabc" });
      expect(platformTokenAddress("net1", {}, root)).to.equal("0xabc");
      expect(platformTokenAddress("net1", { PLATFORM_TOKEN_ADDRESS: "0xdef" }, root)).to.equal("0xdef");
    });
  });
});
