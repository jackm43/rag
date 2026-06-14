import { handleAiGatewayHttpApi } from "./http-api";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handleAiGatewayHttpApi(request, env, ctx);
    if (response) {
      return response;
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
