import { createStealHistoryStore } from '../steal-history-store';
import type { FriendStealRound } from './steal-round';

const { logWarn } = require('../../utils/utils');

const store = createStealHistoryStore();
const pendingResets = new Map<string, FriendStealRound>();
let accountHistoryId = '';

export function configureFriendStealInterval(historyId: unknown): void {
    const id = typeof historyId === 'string' ? historyId : '';
    if (id === accountHistoryId) return;
    accountHistoryId = id;
    pendingResets.clear();
}

function persistReset(friendGid: string, round: FriendStealRound): void {
    store.resetStealProgress(accountHistoryId, friendGid, round);
    pendingResets.delete(friendGid);
}

export function shouldSkipAutoSteal(friendGid: string, skipCount: number, round: FriendStealRound): boolean {
    if (skipCount === 0) return false;
    if (Object.keys(round).length === 0) return true;

    try {
        if (!accountHistoryId) throw new Error('缺少账号历史标识');
        const pending = pendingResets.get(friendGid);
        if (pending) persistReset(friendGid, pending);
        return store.shouldSkipStealRound(accountHistoryId, friendGid, skipCount, round);
    } catch (error) {
        logWarn('好友', `读取或更新自动偷菜进度失败，跳过本次偷菜: ${error instanceof Error ? error.message : String(error)}`, {
            module: 'friend', event: '自动偷菜间隔失败', friendGid,
        });
        return true;
    }
}

export function recordAutoStealSuccess(friendGid: string, round: FriendStealRound): void {
    pendingResets.set(friendGid, round);
    try {
        persistReset(friendGid, round);
    } catch (error) {
        logWarn('好友', `重置自动偷菜进度失败: ${error instanceof Error ? error.message : String(error)}`, {
            module: 'friend', event: '自动偷菜间隔失败', friendGid,
        });
    }
}
