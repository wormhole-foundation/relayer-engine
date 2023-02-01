import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy";
// import Koa from "koa";
// import koaBody from 'koa-body'
import { Plugin, Providers } from "../../packages/relayer-plugin-interface";
import { Storage } from "../storage";

export interface RestConfig {
  restPort: number;
}

// //used for both rest & spy relayer for now
// export async function runRestListener(
//   plugin: Plugin[],
//   storage: Storage,
//   providers: Providers,
//   numGuardians: number,
//   restConfig: RestConfig
// ) {
//   const app = new Koa()
//   app.use(koaBody({
//     jsonLimit: '1mb'
//   }))

//   app.use(async ctx => {
//     if (!ctx.request.body)
//   })
// }
