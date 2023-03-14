import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { Job } from "bullmq";
export declare function metrics(): Middleware<Context & {
    job?: Job;
}>;
