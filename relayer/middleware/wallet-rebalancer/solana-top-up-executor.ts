import { LockProvider, TopUpExecutor } from "../../api";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'

export class SolanaWalletTopUp implements TopUpExecutor {
    constructor(
        private readonly _connection: Connection,
        private readonly _wallet: Keypair,
        private readonly _lock: LockProvider
    ) {}

    async topUp(address: string, amount: bigint) {
        const from = this._wallet.publicKey;
        const lock = await this._lock.acquireLock(from.toString(), 1000 * 60 * 10);
        if (!lock) {
            console.log(`Wallet ${from} is locked, waiting to top up ${address}`);
            return;
        }
        try {
            console.log(`Lock adquired for ${from.toString()}`);
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: from,
                    toPubkey: new PublicKey(address),
                    lamports: amount, // number of SOL to send
                }),
            );
            // Sign transaction, broadcast, and confirm
            const result = sendAndConfirmTransaction(this._connection, transaction, [ this._wallet ]);
            while (true) {
                const receipt = await result;   
                console.log(`Top up wallet ${address} with ${amount} ETH ${receipt}`);             
                if (receipt) {
                    break;
                }
            }
        } finally {
            await this._lock.releaseLock(from.toString());
        }
    }
}