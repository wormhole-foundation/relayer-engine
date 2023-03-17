/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
export interface SourceTxOpts {
    wormscanEndpoint: string;
    retries: 3;
}
export interface SourceTxContext extends Context {
    sourceTxHash?: string;
}
export declare function sourceTx(optsWithoutDefaults?: SourceTxOpts): Middleware<SourceTxContext>;
