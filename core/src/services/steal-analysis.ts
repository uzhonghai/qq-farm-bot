import type Libsql from 'libsql';
import type { FriendStealAnalysis, FriendStealRanking, StealAnalysisOverview, StealAnalysisRange, StealAnalysisWindow } from '../types/steal-history';

const { CONFIG } = require('../config/config');
const { formatDateKeyInTimeZone, getCalendarDateRangeInTimeZone } = require('../utils/utils');

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dateToUtcMs(date: string): number {
    return Date.parse(`${date}T00:00:00Z`);
}

function shiftDate(date: string, days: number): string {
    return new Date(dateToUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function resolveWindow(db: Libsql.Database, accountHistoryId: string, options: StealAnalysisRange, nowMs: number) {
    const timeZone: string = CONFIG.timeZone;
    const today: string = formatDateKeyInTimeZone(nowMs, timeZone);
    const toDate = options.range === 'custom' ? options.toDate : today;
    const { startMs: todayStartMs, endMs: todayEndMs } = getCalendarDateRangeInTimeZone(today, timeZone);
    const endMs: number = toDate === today ? todayEndMs : getCalendarDateRangeInTimeZone(toDate, timeZone).endMs;
    let fromDate: string | null;
    if (options.range === 'all') {
        const first = db.prepare(`
            SELECT MIN(occurred_at_ms) AS time FROM steal_events
            WHERE account_history_id = ? AND occurred_at_ms < ?
        `).get(accountHistoryId, endMs) as { time: number | null };
        fromDate = first.time === null ? null : formatDateKeyInTimeZone(first.time, timeZone);
    } else if (options.range === 'custom') {
        fromDate = options.fromDate;
    } else {
        fromDate = shiftDate(today, { today: 0, '7d': -6, '30d': -29 }[options.range]);
    }
    const dayCount = fromDate ? (dateToUtcMs(toDate) - dateToUtcMs(fromDate)) / DAY_MS + 1 : 0;
    const window: StealAnalysisWindow = { fromDate, toDate, dayCount, timeZone };
    const startMs: number = !fromDate ? endMs : fromDate === today ? todayStartMs
        : getCalendarDateRangeInTimeZone(fromDate, timeZone).startMs;
    return { window, startMs, endMs, today, todayEndMs };
}

type TimestampRow = { occurred_at_ms: number };

function bucketTimes(rows: Iterable<TimestampRow>, timeZone: string, countActiveDays: boolean) {
    const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const dates = new Set<string>();
    const clock = new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    });
    const calendar = countActiveDays ? new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }) : null;

    for (const { occurred_at_ms: time } of rows) {
        const parts = clock.formatToParts(time);
        const day = WEEKDAYS.indexOf(parts.find(part => part.type === 'weekday')!.value);
        const hour = Number(parts.find(part => part.type === 'hour')!.value);
        heatmap[day][hour]++;
        if (calendar) dates.add(calendar.format(time));
    }
    return { heatmap, activeDays: dates.size };
}

export function readStealAnalysis(db: Libsql.Database, accountHistoryId: string, options: StealAnalysisRange, nowMs: number): StealAnalysisOverview {
    return db.transaction(() => {
        const { window, startMs, endMs } = resolveWindow(db, accountHistoryId, options, nowMs);
        const ranking = db.prepare(`
            WITH period AS (
                SELECT friend_gid, COUNT(*) AS count,
                       COUNT(CASE WHEN trigger_type = 'auto' THEN 1 END) AS autoCount,
                       COUNT(CASE WHEN trigger_type = 'manual' THEN 1 END) AS manualCount
                FROM steal_events
                WHERE account_history_id = ?1 AND occurred_at_ms >= ?2 AND occurred_at_ms < ?3
                GROUP BY friend_gid
            )
            SELECT period.friend_gid AS friendGid, period.count, period.autoCount, period.manualCount,
                   (SELECT friend_name FROM steal_events
                    WHERE account_history_id = ?1 AND friend_gid = period.friend_gid AND trim(friend_name) <> ''
                    ORDER BY occurred_at_ms DESC, event_id DESC LIMIT 1) AS friendName,
                   COUNT(*) AS totalCount, MAX(history.occurred_at_ms) AS lastOccurredAtMs
            FROM period JOIN steal_events AS history
              ON history.account_history_id = ?1 AND history.friend_gid = period.friend_gid
            GROUP BY period.friend_gid
            ORDER BY period.count DESC, lastOccurredAtMs DESC, period.friend_gid ASC
        `).all(accountHistoryId, startMs, endMs) as FriendStealRanking[];
        const rows = db.prepare(`
            SELECT occurred_at_ms FROM steal_events
            WHERE account_history_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
        `).iterate(accountHistoryId, startMs, endMs) as Iterable<TimestampRow>;
        const { heatmap } = bucketTimes(rows, window.timeZone, false);
        const count = ranking.reduce((sum, friend) => sum + friend.count, 0);
        const topFiveCount = ranking.slice(0, 5).reduce((sum, friend) => sum + friend.count, 0);
        return {
            window, ranking, heatmap,
            coverage: {
                count, friendCount: ranking.length,
                averageDailyCount: window.dayCount ? count / window.dayCount : 0,
                topFiveShare: count ? topFiveCount / count : 0,
            },
        };
    })();
}

export function readFriendStealAnalysis(db: Libsql.Database, accountHistoryId: string, friendGid: string, options: StealAnalysisRange, nowMs: number): FriendStealAnalysis | null {
    return db.transaction(() => {
        const { window, startMs, endMs, today, todayEndMs } = resolveWindow(db, accountHistoryId, options, nowMs);
        const last7Start = getCalendarDateRangeInTimeZone(shiftDate(today, -6), window.timeZone).startMs;
        const last30Start = getCalendarDateRangeInTimeZone(shiftDate(today, -29), window.timeZone).startMs;
        const stats = db.prepare(`
            SELECT
                (SELECT friend_name FROM steal_events
                 WHERE account_history_id = ?1 AND friend_gid = ?2 AND trim(friend_name) <> ''
                 ORDER BY occurred_at_ms DESC, event_id DESC LIMIT 1) AS friendName,
                COUNT(*) AS totalCount, MAX(occurred_at_ms) AS lastOccurredAtMs,
                COUNT(CASE WHEN occurred_at_ms >= ?3 AND occurred_at_ms < ?4 THEN 1 END) AS count,
                COUNT(CASE WHEN occurred_at_ms >= ?3 AND occurred_at_ms < ?4 AND trigger_type = 'auto' THEN 1 END) AS autoCount,
                COUNT(CASE WHEN occurred_at_ms >= ?5 AND occurred_at_ms < ?7 THEN 1 END) AS last7DaysCount,
                COUNT(CASE WHEN occurred_at_ms >= ?6 AND occurred_at_ms < ?7 THEN 1 END) AS last30DaysCount
            FROM steal_events WHERE account_history_id = ?1 AND friend_gid = ?2
        `).get(accountHistoryId, friendGid, startMs, endMs, last7Start, last30Start, todayEndMs) as
            Omit<FriendStealRanking, 'friendGid' | 'manualCount' | 'lastOccurredAtMs'> & {
                lastOccurredAtMs: number | null; last7DaysCount: number; last30DaysCount: number;
            };
        const { last7DaysCount, last30DaysCount, lastOccurredAtMs, friendName, totalCount, count, autoCount } = stats;
        if (lastOccurredAtMs === null) return null;

        const rows = db.prepare(`
            SELECT occurred_at_ms FROM steal_events
            WHERE account_history_id = ? AND friend_gid = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
        `).iterate(accountHistoryId, friendGid, startMs, endMs) as Iterable<TimestampRow>;
        const { heatmap, activeDays } = bucketTimes(rows, window.timeZone, true);
        return {
            window, heatmap, activeDays, last7DaysCount, last30DaysCount,
            friend: { friendGid, friendName, totalCount, count, autoCount, manualCount: count - autoCount, lastOccurredAtMs },
        };
    })();
}
