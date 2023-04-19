import { LockProvider } from '../../api';

export class Mutex implements LockProvider {
    private readonly _locks: Map<string, boolean> = new Map();

    acquireLock(resourceId: string, ttl: number): Promise<boolean> {
        return new Promise((resolve) => {
            if (this._locks.has(resourceId)) {
                resolve(false);
            } else {
                this._locks.set(resourceId, true);
                setTimeout(() => {
                    this._locks.delete(resourceId);
                }, ttl);
                resolve(true);
            }
        });
    }

    releaseLock(resourceId: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (this._locks.has(resourceId)) {
                this._locks.delete(resourceId);
                resolve(true);
            } else {
                resolve(false);
            }
        });
    }
}