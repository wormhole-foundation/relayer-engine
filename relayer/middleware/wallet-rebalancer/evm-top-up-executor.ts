import { LockProvider, TopUpExecutor } from "../../api";
import { Provider } from "@ethersproject/abstract-provider";
import { Wallet } from "ethers";

export class EVMWalletTopUp implements TopUpExecutor {
    private readonly _provider: Provider

    constructor(
        private readonly _wallet: Wallet,
        private readonly _lock: LockProvider,
        private readonly _confirmations: number = 60
    ) {
        if (this._wallet.provider) {
            this._provider = this._wallet.provider;
        } else {
            throw new Error(`Unable to instantiate ${EVMWalletTopUp.name} executor, wallet does not have a provider`);
        }
    }

    async topUp(address: string, amount: number | BigInt) {
        const from = this._wallet.address;
        const lock = await this._lock.acquireLock(from, 1000 * 60 * 10);
        if (!lock) {
            console.log(`Wallet ${from} is locked, waiting to top up ${address}`);
            return;
        }
        try {
            console.log(`Lock adquired for ${from}`);
            const nonce = await this._wallet.provider.getTransactionCount(from);
            const result = await this._wallet.sendTransaction({
                from,
                to: address,
                value: amount.toString(),
                nonce: nonce
            });
            console.log(`Top up wallet ${address} with ${amount} ETH ${result.hash}`);
            while (true) {
                const receipt = await result.wait(this._confirmations);                
                if (receipt) {
                    break;
                }
            }
        } finally {
            await this._lock.releaseLock(from);
        }
    }
}
