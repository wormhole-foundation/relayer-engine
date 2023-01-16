import winston = require("winston");
export interface LogConfig {
    logLevel?: string;
    logDir?: string;
}
export declare function dbg<T>(x: T, msg?: string): T;
export declare function getLogger(logConfig?: LogConfig): winston.Logger;
export interface ScopedLogger extends winston.Logger {
    scope?: string[];
}
export declare function getScopedLogger(labels: string[], parentLogger?: ScopedLogger): ScopedLogger;
export declare function initLogger(logConfig?: LogConfig): winston.Logger;
