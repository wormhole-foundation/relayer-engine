import { WalletBalance, WalletConfig } from "@xlabs-xyz/wallet-monitor/lib/wallets";
import { WalletRebalancer, TopUpExecutor } from "../../api";

export class MainWorkerAvgWalletRebalancer implements WalletRebalancer {
    private readonly _topUpWalletAddesses;

    constructor(
        private readonly _topUpWalletConfig: WalletConfig[] = [],
        private readonly _minimunThreshold: number,
        private readonly _topUpExecutor: TopUpExecutor
    ) {
        this._topUpWalletAddesses = this._topUpWalletConfig.map(config => config.address);
    }

    async rebalance(wallets: WalletBalance[]): Promise<void> {
        for (const walletBalance of wallets) {
            if (this._topUpWalletAddesses.includes(walletBalance.address)) {
                if (parseInt(walletBalance.rawBalance) < this._minimunThreshold) {
                    const amount = this.computeAmountToTopUp(wallets);
                    await this._topUpExecutor.topUp(walletBalance.address, amount);
                } else {
                    console.log(`Wallet ${walletBalance.address} balance is above threshold`);
                }
            }
        }
    }

    computeAmountToTopUp(wallets: WalletBalance[]): number | BigInt {
        const total = wallets.reduce((acc, wallet) => acc + BigInt(parseInt(wallet.rawBalance)), BigInt(0));
        return total / BigInt(wallets.length);
    }   
}