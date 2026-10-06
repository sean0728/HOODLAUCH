// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only: forces Hardhat to compile Uniswap's real PoolManager and its
// PoolSwapTest router so test/V4TokenFactory.test.js can deploy them. Nothing
// in production imports this file; it is safe to exclude from a production
// build. (PoolManager itself needs the `solmate` npm package to compile.)
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
