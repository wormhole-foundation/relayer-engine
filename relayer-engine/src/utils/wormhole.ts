import { ChainId, VAA } from "@certusone/wormhole-sdk";
import { ParsedVAA } from "@certusone/wormhole-sdk/lib/cjs/algorand";
import * as BN from "bn.js";
import * as ethers from 'ethers'

export const chainIDStrings: { [key in ChainId]: string } = {
  0: "Unset",
  1: "Solana",
  2: "Ethereum",
  3: "Terra",
  4: "BSC",
  5: "Polygon",
  6: "Avalanche",
  7: "Oasis",
  8: "Algorand",
  9: "Aurora",
  10: "Fantom",
  11: "Karura",
  12: "Acala",
  13: "Klaytn",
  14: "Celo",
  15: "NEAR",
  16: "Moonbeam",
  17: "Neon",
  18: "Terra2",

  // TODO: fixme
  19: "",
  20: "",
  21: "",
  22: "",
  23: "",
  24: "",
  25: "",
  26: "",
  3104: "",
  28: ""
};
