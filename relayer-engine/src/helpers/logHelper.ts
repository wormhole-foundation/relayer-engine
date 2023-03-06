import winston = require("winston");
import { getCommonEnv } from "../config";

const cliFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.splat(),
  winston.format.simple(),
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss.SSS",
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(
    (info: any) =>
      `${[info.timestamp]}|${info.level}|${
        info.labels && info.labels.length > 0 ? info.labels.join("|") : "main"
      }: ${info.message} ${info.stack ? "\n" + info.stack : ""} `,
  ),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
  winston.format.errors({ stack: true }),
);

//Be careful not to access this before having called init logger, or it will be undefined
let logger: winston.Logger | undefined;
export interface LogConfig {
  logLevel?: string;
  logDir?: string;
  logFormat?: string;
}

export function dbg<T>(x: T, msg?: string): T {
  if (msg) {
    console.log(msg);
  }
  console.log(x);
  return x;
}

// todo: fallback to console.log if logger not init'd
export function getLogger(logConfig?: LogConfig): winston.Logger {
  if (logger) {
    return logger;
  } else {
    logger = initLogger(logConfig);
    return logger;
  }
}

export interface ScopedLogger extends winston.Logger {
  scope?: string[];
}

// Child loggers can't override defaultMeta, they add their own defaultRequestMetadata
// ...which is stored in a closure we can't read, so we extend it ourselves :)
// https://github.com/winstonjs/winston/blob/a320b0cf7f3c550a354ce4264d7634ebc60b0a67/lib/winston/logger.js#L45
export function getScopedLogger(
  labels: string[],
  parentLogger?: ScopedLogger,
): ScopedLogger {
  const scope = [...(parentLogger?.scope || []), ...labels];
  const logger = parentLogger || getLogger();
  const child: ScopedLogger = logger.child({
    labels: scope,
  });
  child.scope = scope;
  return child;
}

export function initLogger(logConfig?: LogConfig): winston.Logger {
  const { logDir, logLevel, logFormat } = logConfig || {
    logLevel: "info",
    logDir: undefined,
    logFormat: "",
  };
  let useConsole = true;
  let logFileName;
  if (logDir) {
    useConsole = false;
    logFileName =
      logDir + "/relayer_engine." + new Date().toISOString() + ".log";
  }

  let transport: any;
  if (useConsole) {
    console.log(
      "relayer_engine is logging to the console at level [%s]",
      logLevel,
    );

    transport = new winston.transports.Console({
      level: logLevel,
    });
  } else {
    console.log(
      "relayer_engine is logging to [%s] at level [%s]",
      logFileName,
      logLevel,
    );

    transport = new winston.transports.File({
      filename: logFileName,
      level: logLevel,
    });
  }

  const logConfiguration: winston.LoggerOptions = {
    // NOTE: do not specify labels in defaultMeta, as it cannot be overridden
    transports: [transport],
    format: logFormat === "json" ? jsonFormat : cliFormat,
  };

  logger = winston.createLogger(logConfiguration);
  return logger;
}
