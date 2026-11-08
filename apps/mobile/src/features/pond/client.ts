import { GateResponse, PondCounterResponse } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The pond as the app reads it, through the typed client; the zod contracts
// guard the runtime (ADR-003).

/** The pond counter (#54, ADR-013), asked with the person's session for its bar. */
export async function fetchPondCounter(): Promise<PondCounterResponse> {
  const { data, response } = await api.GET("/ponds/counter");
  if (!data) throw new ApiError(`counter answered ${response.status}`, response.status);
  return PondCounterResponse.parse(data);
}

/** Whether matching is open for the person (#500, ADR-060 §4): asked with their session. */
export async function fetchGate(): Promise<GateResponse> {
  const { data, response } = await api.GET("/gate");
  if (!data) throw new ApiError(`gate answered ${response.status}`, response.status);
  return GateResponse.parse(data);
}
