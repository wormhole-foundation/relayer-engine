import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
export interface LoggingContext extends Context {
    logger: Logger;
}
export declare function logging(logger: Logger): Middleware<LoggingContext>;
