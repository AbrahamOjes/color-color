/// A race skin is pure data: names, colours and replay settings. The contract knows nothing
/// about animals or buses; a skin only has to match its deployment's RUNNERS.
export type RunnerStyle = {
  name: string;
  /// Main colour: the trap jacket, the bus body.
  colour: string;
  /// Second colour for `pattern`, and the default for the number when `text` is unset.
  accent: string;
  /// Number colour on the token.
  text: string;
  pattern: "solid" | "stripes" | "hoops";
};

export type RaceSkin = {
  /// Matches the contract's SKIN_ID string, e.g. "greyhounds-v1".
  id: string;
  title: string;
  /// "Trap", "Bus", "Rider": how a runner's number is introduced ("Trap 3").
  runnerLabel: string;
  runners: readonly RunnerStyle[];
  track: { lengthM: number; surface: string };
  replay: { durationMs: number };
};
