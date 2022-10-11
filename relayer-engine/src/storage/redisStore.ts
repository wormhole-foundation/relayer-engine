import { Mutex } from "async-mutex";
import { createClient } from "redis";
import { CommonEnv, getCommonEnv } from "../config";
import { getScopedLogger } from "../helpers/logHelper";
import { PromHelper } from "../helpers/promHelpers";

const logger = () => getScopedLogger(["redisHelper"]);
let promHelper: PromHelper;

export function init(
  ph: PromHelper,
  { redisHost, redisPort }: CommonEnv
): boolean {
  logger().info(
    "will connect to redis at [" + redisHost + ":" + redisPort + "]"
  );
  promHelper = ph;
  return true;
}

// TODO
interface RedisConnectionConfig {}

type RedisClientType = Awaited<ReturnType<typeof createConnection>>;
let rClient: RedisClientType | null;

async function createConnection() {
  const commonEnv = getCommonEnv();
  const { redisHost, redisPort } = commonEnv;
  try {
    let client = createClient({
      socket: {
        host: commonEnv.redisHost,
        port: commonEnv.redisPort,
      },
    });

    client.on("connect", function (err) {
      if (err) {
        logger().error(
          "connectToRedis: failed to connect to host [" +
            redisHost +
            "], port [" +
            redisPort +
            "]: %o",
          err
        );
      }
    });

    await client.connect();
    rClient = client;
    return nnull(client);
  } catch (e) {
    logger().error(
      "connectToRedis: failed to connect to host [" +
        redisHost +
        "], port [" +
        redisPort +
        "]: %o",
      e
    );
    throw new Error("Could not connect to Redis");
  }
}

async function getClient(): Promise<RedisClientType> {
  if (!rClient) {
    rClient = await createConnection();
  }
  return nnull(rClient);
}

export async function getPrefix(
  prefix: string
): Promise<{ key: string; value: string }[]> {
  const client = await getClient();
  const iterator = await client.scanIterator({ MATCH: prefix + "*" });
  const output: { key: string; value: string }[] = [];
  for await (const key of iterator) {
    output.push({ key, value: nnull(await client.get(key)) });
  }
  logger().debug(`Prefix: ${prefix}, output: ${output}`);
  return output;
}

/*
async function insertItemToHashMap(
  mapKey: string,
  fieldKey: string,
  value: string
): Promise<boolean> {
  try {
    logger().debug(
      `Inserting into redis hash set: ${mapKey}, key: ${fieldKey}, value: ${value}`
    );
    const client = await getClient();
    client.hSet(mapKey, fieldKey, value);
    logger().debug(`Done inserting key: ${fieldKey} into ${mapKey}`);
    return true;
  } catch (e) {
    logger().error(
      `Failed inserting into redis hash set: ${mapKey}, key: ${fieldKey}, value: ${value}`
    );
    return false;
  }
}
*/

//The backlog is a FIFO queue of outstanding redis operations
let backlog: (() => Promise<void>)[] = [];
let mutex = new Mutex();

async function enqueueOp<Arg extends any>(
  op: (...args: Arg[]) => Promise<void>
) {
  backlog.push(op);
  await executeBacklog();
}

// This process executes the backlog periodically, so that items inside the backlog
// do not need to wait for a new item to enter the backlog before they can execute again
setInterval(executeBacklog, 1000 * 60);

export async function executeBacklog(): Promise<void> {
  await mutex.runExclusive(async () => {
    for (let i = 0; i < backlog.length; ++i) {
      try {
        await backlog[i]();
      } catch (e) {
        backlog = backlog.slice(i);
        logger().error(e);
        return;
      }
    }
    backlog = [];
  });
}

export async function insertItem(key: string, value: string): Promise<void> {
  //Insert item into end of backlog
  const wrappedOp = async () => {
    logger().debug(`Inserting into redis key: ${key}, value: ${value}`);
    const client = await getClient();
    await client.set(key, value);
    logger().debug(`Done inserting key: ${key}`);
  };
  await enqueueOp(wrappedOp);
}

export async function removeItem(key: string): Promise<void> {
  const wrappedOp = async () => {
    logger().debug(`removing redis key: ${key}`);
    const client = await getClient();
    await client.del(key);
    logger().debug(`Done removing key: ${key}`);
  };
  await enqueueOp(wrappedOp);
}

export interface RedisHelper {
  ensureClient(): Promise<void>;
  insertItem(key: string, value: string): Promise<void>;
  getPrefix(prefix: string): Promise<{ key: string; value: string }[]>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  compareAndSwap(
    prefix: string,
    previousValue: string,
    newValue: string
  ): Promise<boolean>;
}

export function getItem(key: string): Promise<string | null> {
  return getClient().then(c => c.get(key));
}

export async function ensureClient(): Promise<void> {
  await getClient();
}

//This function can modify an existing record.
//It will first make sure that the existing record has not been modified by a different process.
export async function compareAndSwap(
  prefix: string,
  previousValue: string,
  newValue: string
): Promise<boolean> {
  return await mutex.runExclusive(async () => {
    try {
      const client = await getClient();
      const itemInRedis = await client.get(prefix);
      if (itemInRedis !== previousValue) {
        logger().info("Compare and swap failed");
        return false;
      }
      await client.set(prefix, newValue);
      return true;
    } catch (e) {
      logger().error("Failed compare and swap");
      logger().error(e);
      return false;
    }
  });
}

function nnull<T>(x: T | null): T {
  return x as T;
}

const _1: RedisHelper = {
  ensureClient,
  insertItem,
  getPrefix,
  getItem,
  compareAndSwap,
  removeItem,
};
