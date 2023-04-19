/**
 * Abstraction of a top up executor, an implementation of this interface
 * must take care of:
 * <ul>
 *  <li>the actual transfer of funds from one address to another.</li>
 *  <li>locking the `from` address to avoid concurrent top ups, inconsistent state or race conditions.</li>
 * </ul>
 */
export interface TopUpExecutor {
    /**
     * Must execute a top up from one or more wallets to `address` of `amount`, 
     * the implementation of this interface must be responsible for the actual transfer
     * of funds, taking into account that the origin address must have enough funds to 
     * perform the actual transfer and also lock the origin address to avoid concurrent 
     * top ups from the same address and/or inconsistent state (for instance invalid nonce).
     * 
     * @param address target address.
     * @param amount amount to transfer to the targe address.
     */
    topUp(address: string, amount: number | BigInt): Promise<void>;
}