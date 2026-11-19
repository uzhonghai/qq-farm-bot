const { PlantPhase } = require('../../config/config');

interface FriendStealRoundLand {
    plantId: number;
    season: number;
    phase: number;
    phaseStartedAt: number;
}

export type FriendStealRound = Record<number, FriendStealRoundLand>;

export function hasFriendFarmTurnover(previous: FriendStealRound, current: FriendStealRound): boolean {
    return Object.entries(previous).some(([landId, before]) => {
        const after = current[Number(landId)];
        if (!after) return false;
        if (before.plantId !== after.plantId || (before.season > 0 && after.season > before.season)) return true;
        if (before.phase !== PlantPhase.MATURE) return false;
        if (after.phase >= PlantPhase.SEED && after.phase < PlantPhase.MATURE) return true;
        return after.phase === PlantPhase.MATURE && before.phaseStartedAt > 0
            && after.phaseStartedAt > before.phaseStartedAt;
    });
}
