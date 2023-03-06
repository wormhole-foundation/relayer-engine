import { Mutex } from "async-mutex";
import { createClient, createCluster, RedisClientType } from "redis";
import { Logger } from "winston";
import { IRedis, WriteOp, Op } from ".";
import { getScopedLogger } from "../helpers/logHelper";
import { nnull } from "../utils/utils";
import { RedisConfig } from "../config";

// type RedisClientType = Awaited<ReturnType<typeof createConnection>>;

export class RedisWrapper {
  private backlog: WriteOp[] = [];
  private mutex = new Mutex();
  constructor(readonly redis: IRedis, readonly logger: Logger) {}

  static async fromConfig(config: RedisConfig): Promise<RedisWrapper> {
    const logger = getScopedLogger(["RedisWrapper"]);
    const redis = await createConnection(config, logger);
    return new RedisWrapper(redis, logger);
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
  { host, port, username, password, tls, cluster }: RedisConfig,
  logger: Logger,
): Promise<IRedis> {
  try {
    let client: any;
    if (cluster) {
      const clusterConn = createCluster({
        rootNodes: [
          {
            url: `redis://${host}:${port}`,
          },
        ],
        defaults: {
          socket: {
            tls: tls,
          },
          username,
          password,
          isolationPoolOptions: {
            min: 2,
            max: 10,
          },
        },
      });
      await clusterConn.connect();
      logger.info(
        `connected to cluster. Masters found: ${clusterConn.masters
          .map(m => m.id)
          .join(",")}`,
        { cluster: clusterConn }
      );
      client = clusterConn.masters[0].client!;
    } else {
      client = createClient({
        socket: {
          host: host,
          port: port,
          tls: tls,
        },
        username,
        password,
        isolationPoolOptions: {
          min: 2,
          max: 10,
        },
      });
      await client.connect();
    }

    return nnull(client);
  } catch (e) {
    logger.error(
      `connectToRedis: failed to connect to host [${host}], port [${port}]: %o`,
      e,
    );
    throw new Error("Could not connect to Redis");
  }
}
//The backlog is a FIFO queue of outstanding redis operations
