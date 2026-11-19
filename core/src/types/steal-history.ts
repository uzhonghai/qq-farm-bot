export type StealTrigger = 'auto' | 'manual';

export interface StealHistoryEvent {
    eventId: string;
    friendGid: string;
    friendName: string | null;
    occurredAtMs: number;
    triggerType: StealTrigger;
}

export interface StealHistoryCursor {
    occurredAtMs: number;
    eventId: string;
}

export interface StealHistoryFilters {
    friend?: string;
    friendGid?: string;
    triggerType?: StealTrigger;
    fromDate?: string;
    toDate?: string;
}

export interface StealHistoryEntry extends StealHistoryEvent {
    friendTodayCount: number;
    friendTotalCount: number;
    friendSkippedCount: number;
}

export interface StealHistoryPage {
    items: StealHistoryEntry[];
    nextCursor: string | null;
    todayCount: number;
    totalCount: number;
    timeZone: string;
}

export type StealAnalysisRange =
    | { range: 'today' | '7d' | '30d' | 'all' }
    | { range: 'custom'; fromDate: string; toDate: string };

export interface StealAnalysisWindow {
    fromDate: string | null;
    toDate: string;
    dayCount: number;
    timeZone: string;
}

export interface FriendStealRanking {
    friendGid: string;
    friendName: string | null;
    count: number;
    autoCount: number;
    manualCount: number;
    totalCount: number;
    lastOccurredAtMs: number;
}

export interface StealAnalysisOverview {
    window: StealAnalysisWindow;
    coverage: { count: number; friendCount: number; averageDailyCount: number; topFiveShare: number };
    ranking: FriendStealRanking[];
    heatmap: number[][];
}

export interface FriendStealAnalysis {
    window: StealAnalysisWindow;
    friend: FriendStealRanking;
    activeDays: number;
    last7DaysCount: number;
    last30DaysCount: number;
    heatmap: number[][];
}
