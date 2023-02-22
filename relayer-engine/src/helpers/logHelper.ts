import winston = require("winston");
import { getCommonEnv } from "../config";

//Be careful not to access this before having called init logger, or it will be undefined
let logger: winston.Logger | undefined;
export interface LogConfig {
  logLevel?: string;
  logDir?: string;
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
  const { logDir, logLevel } = logConfig || {
    logLevel: "info",
    logDir: undefined,
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
    format: winston.format.json(),
  };

  logger = winston.createLogger(logConfiguration);
  return logger;
}
