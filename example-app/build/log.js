"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rootLogger = void 0;
const winston = require("winston");
exports.rootLogger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            level: "debug",
        }),
    ],
    format: winston.format.combine(winston.format.colorize(), winston.format.splat(), winston.format.simple(), winston.format.timestamp({
        format: "YYYY-MM-DD HH:mm:ss.SSS",
    }), winston.format.errors({ stack: true })),
});
//# sourceMappingURL=log.js.map