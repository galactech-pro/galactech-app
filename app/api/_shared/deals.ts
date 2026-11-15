export const STAGES = ["lead", "qualified", "demo", "proposal", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

/** Win probability (%) a deal gets when it enters a stage. Used for the weighted forecast. */
export const DEFAULT_PROBABILITY: Record<Stage, number> = { lead: 10, qualified: 30, demo: 50, proposal: 70, won: 100, lost: 0 };
