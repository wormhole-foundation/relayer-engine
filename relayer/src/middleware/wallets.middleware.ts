import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";

export interface WalletContext extends Context {
  wallets: any;
}

export function wallets(pks: any): Middleware<WalletContext> {
  return async (ctx: WalletContext, next) => {
    await next();
  };
}
