import { ErrorResponse } from "@kuutti/schema";

// Not in harness.ts: the setup file loads the harness before any test, and a
// schema built from @kuutti/schema before @hono/zod-openapi has extended zod
// lacks .openapi(), so the app the harness builds would refuse its routes.

/** The code of an answer's refusal, its error envelope parsed as the contract says. */
export async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}
