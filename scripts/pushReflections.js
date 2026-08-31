// "Automatic" reflections still need *someone* to call pushReflections() —
// the contract itself never triggers it (see the reflections NatSpec at the
// top of CustomToken.sol for why: looping over an unbounded holder list
// inside every transfer is exactly the gas-griefing failure mode this
// design avoids). This script is that someone: a cron-friendly keeper that
// sweeps a batch of holders on every CustomToken that has reflections
// turned on, so holders keep getting paid automatically without ever
// having to call claimReflections() themselves. Anyone can call
// pushReflections() — it's fully permissionless and can only ever pay
// people exactly what they're already owed — so this script needs no
// special privileges, just a funded wallet to cover gas.
//
// Discovers tokens automatically from CustomTokenFactory.allTokens(), or
// sweeps a fixed list if you'd rather not trust auto-discovery (e.g. to
// exclude a token you know is already fully caught up). Skips a token
// entirely (no transaction, no gas spent) when it has reflections turned
// off or an empty holder registry — pushReflections() is harmless to call
// in either case, but there's no reason to pay gas for a guaranteed no-op.
//
// Required env: CUSTOM_TOKEN_FACTORY_ADDRESS.
// Optional env:
//   CUSTOM_TOKEN_ADDRESSES   comma-separated token addresses to sweep
//                            INSTEAD of auto-discovering from the factory.
//   MAX_HOLDERS_PER_PUSH     default 25 — same meaning as pushReflections'
//                            own maxHolders argument: how many holders one
//                            call sweeps before stopping, regardless of the
//                            total registry size. Keep this low enough that
//                            a single call comfortably fits in a block; the
//                            cursor picks up wherever the last call left
//                            off, so repeated runs cover everyone over time
//                            rather than restarting from the top.
//
// Example (one-shot):
//   CUSTOM_TOKEN_FACTORY_ADDRESS=0x... npx hardhat run scripts/pushReflections.js --network robinhoodMainnet
//
// Example (cron, every 10 minutes):
//   */10 * * * * cd /path/to/hoodlaunch-contracts && CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/pushReflections.js --network robinhoodMainnet >> pushReflections.log 2>&1
const hre = require("hardhat");

async function main() {
  const factoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) throw new Error("Set CUSTOM_TOKEN_FACTORY_ADDRESS to the deployed CustomTokenFactory address.");

  const maxHoldersPerPush = BigInt(process.env.MAX_HOLDERS_PER_PUSH || 25);

  const [signer] = await hre.ethers.getSigners();
  console.log(`Running as ${signer.address}`);

  let tokenAddresses;
  if (process.env.CUSTOM_TOKEN_ADDRESSES) {
    tokenAddresses = process.env.CUSTOM_TOKEN_ADDRESSES.split(",").map((a) => a.trim()).filter(Boolean);
    console.log(`Sweeping ${tokenAddresses.length} explicitly-listed token(s).`);
  } else {
    const factory = await hre.ethers.getContractAt("CustomTokenFactory", factoryAddress, signer);
    tokenAddresses = await factory.allTokens();
    console.log(`Discovered ${tokenAddresses.length} token(s) from CustomTokenFactory.allTokens().`);
  }

  const summary = { swept: 0, skippedNoReflections: 0, skippedEmpty: 0, failed: 0 };

  for (const tokenAddress of tokenAddresses) {
    try {
      const token = await hre.ethers.getContractAt("CustomToken", tokenAddress, signer);

      const reflectionsEnabled = await token.reflectionsEnabled();
      if (!reflectionsEnabled) {
        summary.skippedNoReflections++;
        continue;
      }

      const holderCount = await token.reflectionHolderCount();
      if (holderCount === 0n) {
        summary.skippedEmpty++;
        continue;
      }

      const batchSize = maxHoldersPerPush < holderCount ? maxHoldersPerPush : holderCount;
      const tx = await token.pushReflections(batchSize);
      const receipt = await tx.wait();

      const parsed = receipt.logs
        .map((log) => {
          try {
            return token.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log) => log && log.name === "ReflectionsPushed");

      const holdersPaid = parsed ? parsed.args.holdersPaid : "?";
      const totalPaid = parsed ? hre.ethers.formatEther(parsed.args.totalPaid) : "?";
      console.log(
        `${tokenAddress}: pushed batch of ${batchSize}/${holderCount} holders, ` +
          `paid ${holdersPaid} holder(s), ${totalPaid} total — tx ${receipt.hash}`
      );
      summary.swept++;
    } catch (error) {
      console.error(`${tokenAddress}: failed — ${error.shortMessage || error.message}`);
      summary.failed++;
      // Never let one bad token (paused, unusual reflectionAsset, whatever)
      // stop the rest of the sweep.
    }
  }

  console.log(
    `Done. Swept ${summary.swept}, skipped ${summary.skippedNoReflections} (reflections off), ` +
      `${summary.skippedEmpty} (no holders yet), ${summary.failed} failed.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
