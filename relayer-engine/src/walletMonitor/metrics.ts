import { Gauge } from "prom-client";
import { WalletBalance } from "./balances";
import { wormholeChainIdtoChainName } from "../utils/utils";

export const walletBalancesGauge = new Gauge({
  name: "wallet_balances",
  help: "Balance of the wallets configured for executor plugins",
  labelNames: ["currency", "chain_name", "wallet", "currency_address", "is_native"],
});

export const updateWalletBalances = (balances: WalletBalance[]) => {
  for (const bal of balances) {
    if (bal.currencyName.length === 0) {
      bal.currencyName = "UNK";
    }
    let formBal: number;
    if (!bal.balanceFormatted) {
      formBal = 0;
    } else {
      formBal = parseFloat(bal.balanceFormatted);
    }
    walletBalancesGauge
      .labels({
        currency: bal.currencyName,
        chain_name: wormholeChainIdtoChainName(bal.chainId),
        wallet: bal.walletAddress,
        currency_address: bal.currencyAddressNative,
        is_native: bal.isNative ? "1" : "0",
      })
      .set(formBal);
  }
};