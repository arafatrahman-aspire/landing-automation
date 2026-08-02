/* The only import surface every other module should use for run/campaign
 * state — state/sqlite-repository.mjs is the concrete node:sqlite
 * implementation behind it. Swapping storage backends later (e.g. to
 * Supabase, for a hosted multi-instance deployment) means writing a new
 * concrete module with the same exports and changing the one line below,
 * not touching server.mjs/steps.mjs/graph.mjs. */
export * from "./sqlite-repository.mjs";
