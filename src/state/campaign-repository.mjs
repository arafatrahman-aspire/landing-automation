// The only import surface every other module should use for run/campaign state.
export * from "./sqlite-campaign-repository.mjs";

// sqlite-campaign-repository.mjs is the concrete node:sqlite implementation
// behind this file. Swapping storage backends later (e.g. to Supabase, for a
// hosted multi-instance deployment) means writing a new concrete module with
// the same exports and changing the one export line above — nothing else in
// the codebase imports the concrete module directly.
