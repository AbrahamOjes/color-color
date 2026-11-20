"use client";

import { WagmiProvider, http, createConnector } from "wagmi";
import { polygon, polygonAmoy, hardhat } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  getDefaultConfig,
  getDefaultWallets,
  lightTheme,
  type Wallet,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { type ReactNode } from "react";

// The FIRST chain in this list is wagmi's default for reads with no wallet connected, so it
// must match wherever the contracts in `contracts.ts` actually live. Getting this wrong makes
// every read silently return nothing rather than error, which is hard to spot.
//
// Select with NEXT_PUBLIC_CHAIN: "polygon" | "amoy" | "local". Defaults to amoy.
const isDev = process.env.NODE_ENV === "development";
const target = (process.env.NEXT_PUBLIC_CHAIN ?? "amoy").toLowerCase();
const useLocalChain = isDev && target === "local";

const devChains =
  target === "polygon"
    ? ([polygon, polygonAmoy, hardhat] as const)
    : useLocalChain
      ? ([hardhat, polygonAmoy, polygon] as const)
      : ([polygonAmoy, hardhat, polygon] as const);

/// Anvil's second default account. Its key is the standard public test mnemonic, so it is
/// worthless anywhere real — which is exactly why it is safe to hardcode here.
const ANVIL_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

const LOCAL_WALLET_ICON =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#0f172a"/><circle cx="16" cy="20" r="5" fill="#ef4444"/><circle cx="30" cy="20" r="5" fill="#facc15"/><circle cx="16" cy="32" r="5" fill="#10b981"/><circle cx="30" cy="32" r="5" fill="#3b82f6"/></svg>`,
  );

/**
 * A one-click wallet for local development, offered only when NEXT_PUBLIC_USE_LOCAL_CHAIN is
 * set.
 *
 * Anvil auto-unlocks its dev accounts, so `eth_sendTransaction` is signed by the node itself.
 * The mock connector forwards any method it does not handle straight to the RPC, which means
 * betting, approving and claiming all work with no browser extension involved — useful when
 * MetaMask is wedged behind another wallet extension fighting over `window.ethereum`.
 */
const localTestWallet = (): Wallet => ({
  id: "anvil-local",
  name: "Local Test Wallet",
  iconUrl: async () => LOCAL_WALLET_ICON,
  iconBackground: "#0f172a",
  createConnector: (walletDetails) =>
    createConnector((connectorConfig) => ({
      // `reconnect` is required, or the session drops on every navigation: the mock
      // connector reports isAuthorized() === false without it, so moving from /play to
      // /bets logs you straight back out.
      ...mock({ accounts: [ANVIL_ACCOUNT], features: { reconnect: true } })(connectorConfig),
      ...walletDetails,
    })),
});

const { wallets: defaultWallets } = getDefaultWallets();

const config = getDefaultConfig({
  appName: "ColorColor",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "demo",
  wallets: useLocalChain
    ? [{ groupName: "Local dev", wallets: [localTestWallet] }, ...defaultWallets]
    : defaultWallets,
  chains: isDev ? devChains : ([polygon, polygonAmoy] as const),
  transports: {
    [hardhat.id]: http("http://127.0.0.1:8545"),
    [polygon.id]: http(
      process.env.NEXT_PUBLIC_POLYGON_RPC_URL ??
        "https://polygon-rpc.com"
    ),
    [polygonAmoy.id]: http(
      process.env.NEXT_PUBLIC_AMOY_RPC_URL ??
        "https://rpc-amoy.polygon.technology"
    ),
  },
  ssr: true,
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#0f172a",
            accentColorForeground: "white",
            borderRadius: "large",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
