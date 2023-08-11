import {
    afterAll,
    describe,
    test
} from "@jest/globals";
import { RedisStorage } from "../../relayer/storage/redis-storage";
import { DefaultLabels, StorageMetricLabelOpts, StorageMetricsOpts, createStorageMetrics } from "../../relayer/storage/storage.metrics";
import { setTimeout } from "timers";
import { Registry } from "prom-client";

const vaa = "AQAAAAABAGYGQ1g8mB5UMkeq28zodCdhDUk8YSjRSseFmP3VkKHMDUuZmDpQ6ccsPSx+bUkDIDp+ud6Qfes9nvZcWHkH1tQAZNPDWAg9AQAAAgAAAAAAAAAAAAAAAPiQmC+TEN9X0A9lnPT9h+Za3tjXAAAAAAACh1YBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAAAAtPvycRQ/T797kaXe0xgF5CsiCNYAAgAAAAAAAAAAAAAAAI8moAJdzMbPwHp9OHVigKEOKVrXAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const redisConfig = {
    redis: {
        host: "localhost",
        port: 6301,
    }
};

const getOptions = (metrics?: StorageMetricsOpts) => ({
    queueName: "relayer-test", attempts: 2, concurrency: 1,
    ...redisConfig,
    metrics
});

/**
 * This is an integration test that depends on redis running on port redisConfig.port
 */
describe("redis storage", () => {
    let redisStorage: RedisStorage | null;

    afterAll(async () => {
        await redisStorage?.stopWorker();
        await redisStorage?.close();
    });

    test("should register metrics if no metrics options present", async () => {
        redisStorage = new RedisStorage(getOptions());
        expect(redisStorage.registry.getSingleMetric("delayed_workflows")).toBeDefined();
    });

    test("should customize metrics labels", async () => {
        const labelOpts = new StorageMetricLabelOpts(["targetChain"], (parsedVaa) => Promise.resolve({ "targetChain": "base", "unknown" : "ignore"}));
        const metricsConfig = createStorageMetrics(new Registry(), {}, labelOpts);

        redisStorage = await givenRedisStorageStarted(metricsConfig);

        await whenVaaAdded(redisStorage, vaa);
        await thenExecutionIsFinished(redisStorage, metricsConfig);
    }, 15_000);
});

const givenRedisStorageStarted = async (metricsConfig: StorageMetricsOpts) => {
    const redisStorage = new RedisStorage(getOptions(metricsConfig));
    await redisStorage.startWorker(job => Promise.resolve());
    return redisStorage;
}

const whenVaaAdded = async (redisStorage: RedisStorage, vaa: string) => {
    await redisStorage.addVaaToQueue(Buffer.from(vaa, "base64"));
}

const waitForExecution = (expectation: () => Promise<void>, period: number, maxTimes: number) => {
    let count = 0;
    const timeouts: NodeJS.Timeout[]= []; 
    return new Promise((resolve, reject) => {
        const maybeRun = (error: Error) => {
            if (count >= maxTimes) {
                timeouts.forEach(to => clearTimeout(to));
                reject(error);
                return;
            }
            timeouts.push(setTimeout(runner, period));
        };
        const runner = async () => {
            count += 1;
            try {
                await expectation();
                resolve(null);
            } catch (error) {
                maybeRun(error);
            }
        }
        timeouts.push(setTimeout(runner, 0));
    });
}

const thenExecutionIsFinished = async (redisStorage: RedisStorage, metricsConfig: StorageMetricsOpts) => {
    const expectation = async () => {
        const completedTotalValue = (await redisStorage.registry.getSingleMetric("completed_workflows_total")!.get()).values[0];
        expect(completedTotalValue.value).toBeGreaterThan(0);
        Object.values(DefaultLabels).forEach(labelName => expect(completedTotalValue.labels[labelName]).toBeDefined());
        metricsConfig.labelOpts.labelNames!.forEach(labelName => expect(completedTotalValue.labels[labelName]).toBeDefined());
    };

    return waitForExecution(expectation, 100, 10);
}

