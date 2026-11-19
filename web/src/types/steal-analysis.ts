export type StealAnalysisPeriod = 'today' | '7d' | '30d' | 'all' | 'custom'

export interface StealAnalysisWindow {
  fromDate: string | null
  toDate: string
  dayCount: number
  timeZone: string
}

export interface FriendStealRanking {
  friendGid: string
  friendName: string | null
  count: number
  autoCount: number
  manualCount: number
  totalCount: number
  lastOccurredAtMs: number
}

export interface StealAnalysisOverview {
  window: StealAnalysisWindow
  coverage: { count: number, friendCount: number, averageDailyCount: number, topFiveShare: number }
  ranking: FriendStealRanking[]
  heatmap: number[][]
}

export interface FriendStealAnalysis {
  window: StealAnalysisWindow
  friend: FriendStealRanking
  activeDays: number
  last7DaysCount: number
  last30DaysCount: number
  heatmap: number[][]
}

export type StealTrigger = 'auto' | 'manual'

export interface FriendStealHistoryPage {
  items: { eventId: string, occurredAtMs: number, triggerType: StealTrigger }[]
  nextCursor: string | null
}
