import { Context } from "./context";
export declare type Next = (i?: number) => any;
export declare type Middleware<ContextT extends Context = Context> = (ctx: ContextT, next: Next) => Promise<void>;
export declare type ErrorMiddleware<ContextT extends Context> = (err: Error, ctx: ContextT, next: Next) => Promise<void>;
export declare function compose<T extends Context>(middleware: Middleware<T>[]): Middleware<T>;
export declare function composeError<T extends Context>(middleware: ErrorMiddleware<T>[]): ErrorMiddleware<T>;
