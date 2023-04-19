/**
 * Abstraction for a lock provider. Implementations of this interface should
 * take care of acquiring and releasing locks in a safe manner.
 * 
 * @interface
 * @category API
 */
export interface LockProvider {
    /**
     * The implementation should acquire a lock for the given resource, and must hide detals of the lock from the caller.
     * A consumer must relay on the return value of this method to determine if the lock was acquired or not, no matter if
     * the implementation uses a lock file, a database, or any other mechanism, or it is a distributed lock across multiple
     * process.
     * 
     * @param resourceId the resource to acquire a lock for, for example a wallet address.
     * @param ttl the time to live for the lock in milliseconds. If not provided, the lock will be released when the process exits.
     */
    acquireLock (resourceId: string, ttl?: number): Promise<boolean>;

    /**
     * Must release the lock for the given resource. The implementation must hide the details of the lock from the caller.
     *
     * @param resourceId the resource to release the lock for, for example a wallet address.
     */
    releaseLock (resourceId: string): Promise<boolean>;
}