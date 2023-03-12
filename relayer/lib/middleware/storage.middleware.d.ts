import { Context } from "../context";
import { Middleware } from "../compose.middleware";
interface StorageConfig {
    redis: {
        url: string;
    };
}
export declare function storage(cfg: StorageConfig): Middleware<Context>;
export {};
