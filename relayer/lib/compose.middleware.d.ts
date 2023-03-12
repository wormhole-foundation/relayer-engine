import { Context } from "./context";
export declare type Next = (i?: number) => any;
export declare type Middleware<ContextT extends Context> = (ctx: ContextT, next: Next) => Promise<void>;
export declare function compose<T extends Context>(middleware: Middleware<T>[]): Middleware<T>;
