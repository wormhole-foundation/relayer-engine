import { Next } from "wormhole-relayer";
import { MyRelayerContext } from "./app";
export declare class ApiController {
    processFundsTransfer: (ctx: MyRelayerContext, next: Next) => Promise<void>;
}
