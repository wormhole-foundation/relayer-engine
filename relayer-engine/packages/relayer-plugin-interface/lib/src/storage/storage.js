"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultStorage = exports.createStorage = void 0;
const redis_1 = require("redis");
const _1 = require(".");
const logHelper_1 = require("../helpers/logHelper");
const utils_1 = require("../utils/utils");
const executorHarness_1 = require("../executor/executorHarness");
const redisStore_1 = require("./redisStore");
const crypto_1 = require("crypto");
const READY_WORKFLOW_QUEUE = "__workflowQ"; // workflows ready to execute
const ACTIVE_WORKFLOWS_QUEUE = "__activeWorkflows"; // workflows currently executing
const DELAYED_WORKFLOWS_QUEUE = "__delayedWorkflows"; // failed workflows being delayed before going back to ready to execute
const STAGING_AREA_KEY = "__stagingArea";
const COMPLETE = "__complete";
const CHECK_REQUEUED_WORKFLOWS_LOCK = "__isRequeueRunning";
async function createStorage(plugins, config, storeType = _1.StoreType.InMemory, logger) {
    switch (storeType) {
        case _1.StoreType.InMemory:
            return new DefaultStorage(new _1.InMemory(), plugins, config.defaultWorkflowOptions, logger || (0, logHelper_1.getLogger)());
        case _1.StoreType.Redis:
            const redisConfig = config;
            if (!redisConfig.redisHost || !redisConfig.redisPort) {
                throw new utils_1.EngineError("Redis config values must be present if redis store type selected");
            }
            return new DefaultStorage(await redisStore_1.DefaultRedisWrapper.fromConfig(redisConfig), plugins, config.defaultWorkflowOptions, logger || (0, logHelper_1.getLogger)());
        default:
            throw new utils_1.EngineError("Unrecognized storage type", storeType);
    }
}
exports.createStorage = createStorage;
function sanitize(dirtyString) {
    return dirtyString.replace("[^a-zA-z_0-9]*", "");
}
class DefaultStorage {
    store;
    plugins;
    logger;
    nextReadyWorkflowCheckId;
    id = (0, crypto_1.randomUUID)();
    defaultWorkflowOptions;
    constructor(store, plugins, defaultWorkflowOptions, logger) {
        this.store = store;
        this.logger = (0, logHelper_1.getScopedLogger)([`GlobalStorage`], logger);
        this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
        this.defaultWorkflowOptions = defaultWorkflowOptions;
    }
    // Number of active workflows currently being executed
    numActiveWorkflows() {
        return this.store.withRedis(redis => redis.lLen(ACTIVE_WORKFLOWS_QUEUE));
    }
    numEnqueuedWorkflows() {
        return this.store.withRedis(redis => redis.lLen(READY_WORKFLOW_QUEUE));
    }
    numDelayedWorkflows() {
        return this.store.withRedis(redis => redis.lLen(DELAYED_WORKFLOWS_QUEUE));
    }
    // Add a workflow to the queue to be processed
    addWorkflow(workflow, workflowOptions) {
        // set defaults if no values were passed;
        workflow.maxRetries =
            workflow.maxRetries ?? this.defaultWorkflowOptions.maxRetries;
        const key = workflowKey(workflow);
        return this.store.runOpWithRetry(async (redis) => {
            await redis.watch(key);
            if (await redis.get(key)) {
                await redis.unwatch();
                return;
            }
            workflow.scheduledAt = new Date();
            await redis
                .multi()
                .lPush(READY_WORKFLOW_QUEUE, key)
                .hSet(key, "data", JSON.stringify(workflow.data))
                .exec(true);
        });
    }
    // Requeue a workflow to be processed
    async requeueWorkflow(workflow, reExecuteAt) {
        const key = workflowKey(workflow);
        return this.store.runOpWithRetry(async (redis) => {
            await redis.watch(key);
            const global = await redis.get(key);
            let multi = redis.multi();
            if (!global) {
                throw new Error("Trying to requeue workflow that doesn't exist");
            }
            else if (global == COMPLETE) {
                // requeue completed workflow if mistakenly completed
                this.logger.info("requeueing workflow that is marked complete: " + workflow.id);
                multi = multi.set(key, JSON.stringify(workflow));
            }
            let op = await multi
                .lRem(READY_WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
                .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key); // remove key from workflow queue if present
            op =
                reExecuteAt < new Date()
                    ? op.lPush(READY_WORKFLOW_QUEUE, key) //if  Add directly to ready workflows
                    : op.zAdd(DELAYED_WORKFLOWS_QUEUE, [
                        { value: key, score: reExecuteAt.getTime() },
                    ]); // Add to delayed worfklows
            await op.exec(true);
        });
    }
    // Mark a workflow as complete and remove it from the set of active workflows
    completeWorkflow(workflow) {
        const key = workflowKey(workflow);
        return this.store.runOpWithRetry(async (redis) => {
            await redis.watch(key);
            if ((await redis.get(key)) == COMPLETE) {
                await redis.unwatch();
                return;
            }
            await redis
                .multi()
                .set(key, COMPLETE)
                .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
                .exec(true);
        });
    }
    // Get the next workflow to process.
    // Removes the key from the workflow queue and places it in the active workflow set
    async getNextWorkflow(timeoutInSeconds) {
        return this.store.withRedis(async (redis) => {
            const key = await redis.blMove(READY_WORKFLOW_QUEUE, ACTIVE_WORKFLOWS_QUEUE, _1.Direction.LEFT, _1.Direction.RIGHT, timeoutInSeconds);
            if (!key) {
                return null;
            }
            const raw = (0, utils_1.nnull)(await redis.get(key));
            const workflow = JSON.parse(raw);
            if (workflow.scheduledAt) {
                workflow.scheduledAt = new Date(workflow.scheduledAt);
            }
            return { workflow, plugin: (0, utils_1.nnull)(this.plugins.get(workflow.pluginName)) };
        });
    }
    // Demote workflows from active set based off plugin config
    async handleStorageStartupConfig(plugins) {
        this.logger.debug("Handling storage startup config");
        const pluginToShouldDemote = new Map(plugins.map(p => [p.pluginName, p.demoteInProgress]));
        this.logger.info("Checking for inProgress workflows to demote on startup");
        try {
            return this.store.withRedis(async (redis) => {
                const keys = await redis.hKeys(ACTIVE_WORKFLOWS_QUEUE);
                for await (const key of keys) {
                    const workflow = await redis
                        .get(key)
                        .then(utils_1.nnull)
                        .then(JSON.parse);
                    if (pluginToShouldDemote.get(workflow.pluginName)) {
                        await this.requeueWorkflow(workflow, new Date());
                    }
                }
            });
        }
        catch (e) {
            this.logger.error("Encountered an error while demoting in progress items at startup.");
            this.logger.error(e);
        }
    }
    getStagingAreaKeyLock(pluginName) {
        return new DefaultStagingAreaKeyLock(this.store, this.logger, pluginName);
    }
    // this is a simple lock which under the wrong conditions cannot guarantee exclusivity
    // if we need a better lock we can use redlock (https://redis.io/docs/manual/patterns/distributed-locks/), but that's not needed right now as it's ok for 2 instances to check this queue.
    // the lock is just to avoid duplicated work, not to guarantee exclusivity.
    async acquireUnsafeLock(key, expiresInMs) {
        const lockKey = `locks:${key}`;
        const lock = await this.store.withRedis(redis => redis.set(lockKey, this.id, {
            NX: true,
            PX: expiresInMs,
        }));
        return !!lock;
    }
    async releaseUnsafeLock(key) {
        const lockKey = `locks:${key}`;
        const lock = await this.store.withRedis(async (redis) => {
            await redis.watch(lockKey);
            const holder = await redis.get(lockKey);
            if (holder === this.id) {
                return redis.multi().del(lockKey).exec();
            }
            return 0;
        });
        return Array.isArray(lock) ? lock[0] === 1 : false;
    }
    async moveWorkflowsToReadyQueue() {
        const lock = await this.acquireUnsafeLock(CHECK_REQUEUED_WORKFLOWS_LOCK, 100);
        if (!lock) {
            this.logger.info("could not acquire lock to move workflows");
            return 0;
        }
        let jobsMoved = 0;
        try {
            await this.store.withRedis(async (redis) => {
                await redis.watch(CHECK_REQUEUED_WORKFLOWS_LOCK);
                const pendingJobs = await redis.zRangeWithScores(DELAYED_WORKFLOWS_QUEUE, 0, executorHarness_1.MAX_ACTIVE_WORKFLOWS);
                if (!pendingJobs.length) {
                    return;
                }
                const now = new Date();
                const readyWorkflows = [];
                for (const { value: workflowName, score: timeInMs } of pendingJobs) {
                    const execAt = new Date(timeInMs);
                    if (execAt > now) {
                        break;
                    }
                    readyWorkflows.push(workflowName);
                }
                // TODO remove from pending queue
                await redis
                    .multi()
                    .lPush(READY_WORKFLOW_QUEUE, readyWorkflows)
                    .zRem(DELAYED_WORKFLOWS_QUEUE, readyWorkflows)
                    .exec();
                jobsMoved = readyWorkflows.length;
                return;
            });
            return jobsMoved;
            // we avoid releasing the lock to avoid multiple instances checking redis aggressively, so at most we check 10 times per second.
        }
        catch (e) {
            this.logger.info("could not complete moving jobs before lock expiration");
        }
        finally {
            return 0;
        }
    }
}
exports.DefaultStorage = DefaultStorage;
function workflowKey(workflow) {
    return `${workflow.pluginName}/${workflow.id}`;
}
class DefaultStagingAreaKeyLock {
    store;
    logger;
    stagingAreaKey;
    constructor(store, logger, pluginName) {
        this.store = store;
        this.logger = logger;
        this.stagingAreaKey = `${STAGING_AREA_KEY}/${sanitize(pluginName)}`;
    }
    getKeys(keys) {
        return this.store.withRedis(async (redis) => this.getKeysInternal(redis, keys));
    }
    getKeysInternal(redis, keys) {
        return Promise.all(keys.map(async (k) => {
            const val = await redis.get(`${this.stagingAreaKey}/${k}`);
            return [k, val !== null ? JSON.parse(val) : undefined];
        })).then(Object.fromEntries);
    }
    async withKey(keys, f) {
        try {
            return await this.store.withRedis(async (redis) => {
                // watch keys so that no other listners can alter
                await redis.watch(keys.map(key => `${this.stagingAreaKey}/${key}`));
                const kvs = await this.getKeysInternal(redis, keys);
                // const original = Object.assign({}, kvs);
                const { newKV, val } = await f(kvs);
                // update only those keys that returned and were different than before
                let multi = redis.multi();
                for (const [k, v] of Object.entries(newKV)) {
                    // todo: consider checking for changes
                    // if (v !== original[k]) {
                    multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
                    // }
                }
                await multi.exec(true);
                return val;
            });
        }
        catch (e) {
            if (e instanceof redis_1.WatchError) {
                // todo: retry in this case?
                this.logger.warn("Staging area key was mutated while executing");
            }
            else {
                this.logger.error("Error while reading and writing staging area keys");
            }
            this.logger.error(e);
            throw e;
        }
    }
}
//# sourceMappingURL=storage.js.map