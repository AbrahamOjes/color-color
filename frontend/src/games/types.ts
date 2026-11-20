import { type Abi, type Address } from "viem";

/// Which board and decoders a game uses. Every kind runs on PredictionGameBase, so the
/// shared hooks work for all of them; only selection encoding and results differ.
export type GameKind = "colorcolor" | "race";

/// One deployed game, as listed in the lobby.
export type GameInstance = {
  id: string;
  kind: GameKind;
  title: string;
  tagline: string;
  address: Address;
  abi: Abi;
  /// Race games only: the skin to use if the contract's SKIN_ID names none we know.
  skin?: string;
};

/// Defaults for a known game id: everything except the address.
export type GameDefaults = Omit<GameInstance, "id" | "address">;
