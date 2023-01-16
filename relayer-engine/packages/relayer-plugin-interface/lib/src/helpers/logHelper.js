"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLogger = exports.getScopedLogger = exports.getLogger = exports.dbg = void 0;
const winston = require("winston");
//Be careful not to access this before having called init logger, or it will be undefined
let logger;
function dbg(x, msg) {
    if (msg) {
        console.log(msg);
    }
    console.log(x);
    return x;
}
exports.dbg = dbg;
// todo: fallback to console.log if logger not init'd
function getLogger(logConfig) {
    if (logger) {
        return logger;
    }
    else {
        logger = initLogger(logConfig);
        return logger;
    }
}
exports.getLogger = getLogger;
// Child loggers can't override defaultMeta, they add their own defaultRequestMetadata
// ...which is stored in a closure we can't read, so we extend it ourselves :)
// https://github.com/winstonjs/winston/blob/a320b0cf7f3c550a354ce4264d7634ebc60b0a67/lib/winston/logger.js#L45
function getScopedLogger(labels, parentLogger) {
    const scope = [...(parentLogger?.scope || []), ...labels];
    const logger = parentLogger || getLogger();
    const child = logger.child({
        labels: scope,
    });
    child.scope = scope;
    return child;
}
exports.getScopedLogger = getScopedLogger;
function initLogger(logConfig) {
    const { logDir, logLevel } = logConfig || {
        logLevel: "info",
        logDir: undefined,
    };
    let useConsole = true;
    let logFileName;
    if (logDir) {
        useConsole = false;
        logFileName = logDir + "/spy_relay." + new Date().toISOString() + ".log";
    }
    let transport;
    if (useConsole) {
        console.log("spy_relay is logging to the console at level [%s]", logLevel);
        transport = new winston.transports.Console({
            level: logLevel,
        });
    }
    else {
        console.log("spy_relay is logging to [%s] at level [%s]", logFileName, logLevel);
        transport = new winston.transports.File({
            filename: logFileName,
            level: logLevel,
        });
    }
    const logConfiguration = {
        // NOTE: do not specify labels in defaultMeta, as it cannot be overridden
        transports: [transport],
        format: winston.format.combine(winston.format.colorize(), winston.format.splat(), winston.format.simple(), winston.format.timestamp({
            format: "YYYY-MM-DD HH:mm:ss.SSS",
        }), winston.format.errors({ stack: true }), winston.format.printf((info) => `${[info.timestamp]}|${info.level}|${info.labels && info.labels.length > 0
            ? info.labels.join("|")
            : "main"}: ${info.message} ${info.stack ? "\n" + info.stack : ""} `)),
    };
    logger = winston.createLogger(logConfiguration);
    return logger;
}
exports.initLogger = initLogger;
//# sourceMappingURL=logHelper.js.map