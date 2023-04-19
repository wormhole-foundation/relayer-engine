import { WalletBalance } from '@xlabs-xyz/wallet-monitor/lib/wallets'

export interface WalletRebalancer {
    rebalance(wallets: WalletBalance[]): void;
    computeAmountToTopUp(wallets: WalletBalance[]): number | BigInt;
}