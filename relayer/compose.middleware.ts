import { Context } from "./context.js";

export type Next = (i?: number) => any;
export type Middleware<ContextT extends Context = Context> = (
  ctx: ContextT,
  next: Next,
) => Promise<void>;
export type ErrorMiddleware<ContextT extends Context = Context> = (
  err: Error,
  ctx: ContextT,
  next: Next,
) => Promise<void>;

export function compose<T extends Context>(
  middleware: Middleware<T>[],
): Middleware<T> {
  return async function (ctx: T, next: Next = () => {}): Promise<void> {
    async function callNext(i: number): Promise<any> {
      if (i === middleware.length) {
        return next();
      }
      let fn = middleware[i];
      return fn(ctx, callNext.bind(null, i + 1));
    }

    return callNext(0);
  };
}

// error middleware. TODO: cleanup
export function composeError<T extends Context>(
  middleware: ErrorMiddleware<T>[],
): ErrorMiddleware<T> {
  return async function (
    err: Error,
    ctx: T,
    next: Next = () => {},
  ): Promise<void> {
    async function callNext(i: number): Promise<any> {
      if (i === middleware.length) {
        return next();
      }
      const fn = middleware[i];
      return fn(err, ctx, callNext.bind(null, i + 1));
    }

    return callNext(0);
  };
}

export function isErrorMiddlewareList<T extends Context>(
  list: any[],
): list is ErrorMiddleware<T>[] {
  return list.every(f => {
    return f.length > 2;
  });
}
