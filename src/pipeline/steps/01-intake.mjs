import * as runStore from "../../state/campaign-repository.mjs";
import { logStage } from "./log-helper.mjs";

export async function intake(state) {
  await runStore.heartbeat(state.runId, "intake");
  await logStage(state.runId, `intake: campaign "${state.request.campaignName}" (${state.request.slug})`);
  return {};
}
