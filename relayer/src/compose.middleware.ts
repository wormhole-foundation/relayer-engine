import { Context } from "./context";

export type Next = (i?: number) => any;
export type Middleware<ContextT extends Context> = (
  ctx: ContextT,
  next: Next
) => Promise<void>;

export function compose<T extends Context>(
  middleware: Middleware<T>[]
): Middleware<T> {
  return async function (ctx: T, next: Next = () => {}) {
    async function callNext(i: number): Promise<any> {
      if (i >= middleware.length) {
        return next();
      }
      let fn = middleware[i];
      return fn(ctx, callNext.bind(null, i + 1));
    }
    await callNext(0);
  };
}
