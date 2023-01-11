import { Mutex } from "async-mutex";
import { createClient, RedisClientType } from "redis";
import { Logger } from "winston";
import { IRedis, WriteOp, RedisWrapper, Op } from ".";
import { CommonEnv, getCommonEnv } from "../config";
import { getScopedLogger } from "../helpers/logHelper";
import { nnull } from "../utils/utils";

// type RedisClientType = Awaited<ReturnType<typeof createConnection>>;
export interface RedisConfig {
  redisHost: string;
  redisPort: number;
}

export class DefaultRedisWrapper implements RedisWrapper {
  private backlog: WriteOp[] = [];
  private mutex = new Mutex();
  constructor(readonly redis: IRedis, readonly logger: Logger) {}

  static async fromConfig(config: RedisConfig): Promise<RedisWrapper> {
    const logger = getScopedLogger(["DefaultRedisWrapper"]);
    const redis = await createConnection(config, logger);
    return new DefaultRedisWrapper(redis, logger);
  }

  async runOpWithRetry(op: WriteOp): Promise<void> {
    this.backlog.push(op);
    await this.executeBacklog();
  }

  withRedis<T>(op: Op<T>): Promise<T> {
    return this.redis.executeIsolated(op);
  }

  // This process executes the backlog periodically, so that items inside the backlog
  // do not need to wait for a new item to enter the backlog before they can execute again
  // setInterval(executeBacklog, 1000 * 60);

  async executeBacklog(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      for (let i = 0; i < this.backlog.length; ++i) {
        try {
          await this.redis.executeIsolated(this.backlog[i]);
        } catch (e) {
          this.backlog = this.backlog.slice(i);
          this.logger.error(e);
          return;
        }
      }
      this.backlog = [];
    });
  }
}

async function createConnection(
  { redisHost, redisPort }: RedisConfig,
  logger: Logger,
): Promise<IRedis> {
  try {
    let client = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
      },
    });

    client.on("connect", function (err) {
      if (err) {
        logger.error(
          "connectToRedis: failed to connect to host [" +
            redisHost +
            "], port [" +
            redisPort +
            "]: %o",
          err,
        );
      }
    });

    await client.connect();
    return nnull(client);
  } catch (e) {
    logger.error(
      "connectToRedis: failed to connect to host [" +
        redisHost +
        "], port [" +
        redisPort +
        "]: %o",
      e,
    );
    throw new Error("Could not connect to Redis");
  }
}
//The backlog is a FIFO queue of outstanding redis operations
