import { handleDeployHttpApi } from "./http-api";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return await handleDeployHttpApi(request, env, ctx)
      ?? Response.json({ errors: [{ status: 404, code: "not_found", title: "Not found" }] }, { status: 404 });
  },
};
