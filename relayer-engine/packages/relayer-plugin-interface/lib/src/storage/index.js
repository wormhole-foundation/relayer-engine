"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Direction = exports.StoreType = exports.createStorage = exports.InMemory = void 0;
var inMemoryStore_1 = require("./inMemoryStore");
Object.defineProperty(exports, "InMemory", { enumerable: true, get: function () { return inMemoryStore_1.InMemory; } });
var storage_1 = require("./storage");
Object.defineProperty(exports, "createStorage", { enumerable: true, get: function () { return storage_1.createStorage; } });
var StoreType;
(function (StoreType) {
    StoreType["InMemory"] = "InMemory";
    StoreType["Redis"] = "Redis";
})(StoreType = exports.StoreType || (exports.StoreType = {}));
var Direction;
(function (Direction) {
    Direction["LEFT"] = "LEFT";
    Direction["RIGHT"] = "RIGHT";
})(Direction = exports.Direction || (exports.Direction = {}));
// ensure IRedis is subset of real client
const _ = {};
//# sourceMappingURL=index.js.map