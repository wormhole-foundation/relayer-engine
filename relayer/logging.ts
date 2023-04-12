import * as winston from "winston";

export const defaultLogger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: "debug",
    }),
  ],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss.SSS",
    }),
    winston.format.errors({ stack: true }),
  ),
});
