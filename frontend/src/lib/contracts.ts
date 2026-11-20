import { type Abi, type Address } from "viem";
import HouseVaultABI from "./abi/HouseVault.json";
import ReferralManagerABI from "./abi/ReferralManager.json";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// Shared contract addresses — update after deployment. Game addresses live in the game
// registry (src/games/registry.ts).
// The retired daily lottery (Lottery / LPVault) is no longer part of this app; those
// contracts remain live on Amoy and their source is archived in contracts/src/legacy.
export const CONTRACTS = {
  houseVault: (process.env.NEXT_PUBLIC_HOUSE_VAULT_ADDRESS ?? ZERO) as Address,
  referralManager: (process.env.NEXT_PUBLIC_REFERRAL_MANAGER_ADDRESS ?? ZERO) as Address,
  usdc: (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? ZERO) as Address,
} as const;

// Foundry-extracted JSON widens every literal to `string`, so the arrays need an explicit
// `Abi` assertion — `useReadContracts` rejects them otherwise, unlike the singular hook.
export const ABIS = {
  houseVault: HouseVaultABI as Abi,
  referralManager: ReferralManagerABI as Abi,
} as const;

export const USDC_DECIMALS = 6;

// ERC20 minimal ABI for approve/allowance/balanceOf
export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
