import { randomUUID } from 'node:crypto';
import type { StealHistoryEvent, StealTrigger } from '../../types/steal-history';

export function createStealHistoryRecorder(
    friendGid: string,
    friendName: string | null,
    triggerType: StealTrigger,
    report: (event: StealHistoryEvent) => void,
) {
    let identity: { eventId: string; occurredAtMs: number } | undefined;
    let receivedReply = false;

    async function capture(harvest: () => Promise<void>): Promise<void> {
        identity ??= { eventId: randomUUID(), occurredAtMs: Date.now() };
        await harvest();
        receivedReply = true;
    }

    function finish(): void {
        if (!identity || !receivedReply) return;
        receivedReply = false;
        report({ ...identity, friendGid, friendName, triggerType });
    }

    return { capture, finish };
}
