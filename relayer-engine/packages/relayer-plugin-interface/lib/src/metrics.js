"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginsConfiguredGauge = void 0;
const prom_client_1 = require("prom-client");
exports.pluginsConfiguredGauge = new prom_client_1.Gauge({
    name: "plugins_configured",
    help: "Number of plugins configured in the host.",
});
//# sourceMappingURL=metrics.js.map