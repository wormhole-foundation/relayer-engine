import { Middleware } from "../compose.middleware";
import { Context } from "../context";
export interface WalletContext extends Context {
    wallets: any;
}
export declare function wallets(pks: any): Middleware<WalletContext>;
