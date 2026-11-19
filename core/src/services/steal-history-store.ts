import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Libsql from 'libsql';
import type { StealAnalysisRange, StealHistoryCursor, StealHistoryEntry, StealHistoryEvent, StealHistoryFilters, StealHistoryPage } from '../types/steal-history';
import { hasFriendFarmTurnover, type FriendStealRound } from './friend/steal-round';
import { readFriendStealAnalysis, readStealAnalysis } from './steal-analysis';

const { CONFIG } = require('../config/config');
const { getDataFile } = require('../config/runtime-paths');
const { getCalendarDateRangeInTimeZone, getDateRangeInTimeZone } = require('../utils/utils');

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS steal_events (
        event_id TEXT NOT NULL PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_history_id TEXT NOT NULL,
        friend_gid TEXT NOT NULL,
        friend_name TEXT,
        occurred_at_ms INTEGER NOT NULL,
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('auto', 'manual')),
        quantity_status TEXT NOT NULL CHECK (quantity_status IN ('confirmed', 'partial', 'unknown'))
    );
    CREATE INDEX IF NOT EXISTS idx_steal_events_account_time
        ON steal_events (account_history_id, occurred_at_ms DESC, event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_steal_events_account_friend_time
        ON steal_events (account_history_id, friend_gid, occurred_at_ms);
    CREATE TABLE IF NOT EXISTS friend_steal_progress (
        account_history_id TEXT NOT NULL,
        friend_gid TEXT NOT NULL,
        skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
        PRIMARY KEY (account_history_id, friend_gid)
    );
    CREATE TABLE IF NOT EXISTS friend_steal_rounds (
        account_history_id TEXT NOT NULL,
        friend_gid TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (account_history_id, friend_gid),
        FOREIGN KEY (account_history_id, friend_gid)
            REFERENCES friend_steal_progress (account_history_id, friend_gid) ON DELETE CASCADE
    );
`;

export function parseStealHistoryCursor(value: string): StealHistoryCursor | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
    try {
        const { occurredAtMs, eventId } = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (Number.isSafeInteger(occurredAtMs) && occurredAtMs > 0
            && typeof eventId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(eventId)) {
            return { occurredAtMs, eventId };
        }
    } catch { /* malformed cursor */ }
    return null;
}

export function createStealHistoryStore(filename = getDataFile('steal-history.db')) {
    let db: Libsql.Database | undefined;

    function getDatabase(): Libsql.Database {
        if (db) return db;
        const Database: typeof Libsql = (process as NodeJS.Process & { pkg?: unknown }).pkg
            ? require('../pkg-libsql/node_modules/libsql')
            : require('libsql');
        mkdirSync(dirname(filename), { recursive: true });
        const connection = new Database(filename, { timeout: 500 });
        try {
            connection.pragma('journal_mode = WAL');
            connection.pragma('foreign_keys = ON');
            connection.transaction(() => connection.exec(SCHEMA))();
        } catch (error) {
            connection.close();
            throw error;
        }
        db = connection;
        return db;
    }

    function write(accountId: string, accountHistoryId: string, event: StealHistoryEvent): void {
        // The original SQLite schema requires a quantity status on every row.
        getDatabase().prepare(`
            INSERT INTO steal_events (
                event_id, account_id, account_history_id, friend_gid, friend_name,
                occurred_at_ms, trigger_type, quantity_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown')
            ON CONFLICT (event_id) DO NOTHING
        `).run(
            event.eventId, accountId, accountHistoryId, event.friendGid, event.friendName,
            event.occurredAtMs, event.triggerType,
        );
    }

    function saveStealRound(connection: Libsql.Database, accountHistoryId: string, friendGid: string, round: FriendStealRound): void {
        connection.prepare(`
            INSERT INTO friend_steal_rounds (account_history_id, friend_gid, snapshot_json)
            VALUES (?, ?, ?)
            ON CONFLICT (account_history_id, friend_gid) DO UPDATE SET snapshot_json = excluded.snapshot_json
        `).run(accountHistoryId, friendGid, JSON.stringify(round));
    }

    function shouldSkipStealRound(accountHistoryId: string, friendGid: string, skipCount: number, round: FriendStealRound): boolean {
        const connection = getDatabase();
        return connection.transaction(() => {
            const progress = connection.prepare(`
                SELECT skipped_count AS skippedCount, snapshot_json AS snapshotJson
                FROM friend_steal_progress
                LEFT JOIN friend_steal_rounds USING (account_history_id, friend_gid)
                WHERE account_history_id = ? AND friend_gid = ?
            `).get(accountHistoryId, friendGid) as { skippedCount: number; snapshotJson: string | null } | undefined;
            if (!progress) return false;

            if (progress.snapshotJson !== null) {
                if (!hasFriendFarmTurnover(JSON.parse(progress.snapshotJson), round)) return true;
                if (progress.skippedCount >= skipCount) return false;
                connection.prepare(`
                    UPDATE friend_steal_progress
                    SET skipped_count = skipped_count + 1
                    WHERE account_history_id = ? AND friend_gid = ?
                `).run(accountHistoryId, friendGid);
            }
            // A saved counter from before this upgrade has no round to compare against.
            saveStealRound(connection, accountHistoryId, friendGid, round);
            return true;
        }).immediate();
    }

    function resetStealProgress(accountHistoryId: string, friendGid: string, round: FriendStealRound): void {
        const connection = getDatabase();
        connection.transaction(() => {
            connection.prepare(`
                INSERT INTO friend_steal_progress (account_history_id, friend_gid, skipped_count)
                VALUES (?, ?, 0)
                ON CONFLICT (account_history_id, friend_gid) DO UPDATE SET skipped_count = 0
            `).run(accountHistoryId, friendGid);
            saveStealRound(connection, accountHistoryId, friendGid, round);
        })();
    }

    function list(accountHistoryId: string, limit: number, cursor: StealHistoryCursor | null, filters: StealHistoryFilters = {}, nowMs = Date.now()): StealHistoryPage {
        const timeZone: string = CONFIG.timeZone;
        const { startMs, endMs } = getDateRangeInTimeZone(nowMs, timeZone);
        const conditions = ['account_history_id = ?'];
        const pageParams: (string | number)[] = [accountHistoryId];
        if (filters.friend) {
            conditions.push('(friend_gid = ? OR instr(lower(friend_name), lower(?)) > 0)');
            pageParams.push(filters.friend, filters.friend);
        }
        if (filters.friendGid) {
            conditions.push('friend_gid = ?');
            pageParams.push(filters.friendGid);
        }
        if (filters.triggerType) {
            conditions.push('trigger_type = ?');
            pageParams.push(filters.triggerType);
        }
        if (filters.fromDate) {
            conditions.push('occurred_at_ms >= ?');
            pageParams.push(getCalendarDateRangeInTimeZone(filters.fromDate, timeZone).startMs);
        }
        if (filters.toDate) {
            conditions.push('occurred_at_ms < ?');
            pageParams.push(getCalendarDateRangeInTimeZone(filters.toDate, timeZone).endMs);
        }
        if (cursor) {
            conditions.push('(occurred_at_ms, event_id) < (?, ?)');
            pageParams.push(cursor.occurredAtMs, cursor.eventId);
        }
        const connection = getDatabase();
        const { events, todayCount, totalCount } = connection.transaction(() => {
            const { todayCount, totalCount } = connection.prepare(`
                SELECT
                    (SELECT COUNT(*) FROM steal_events WHERE account_history_id = ?) AS totalCount,
                    (SELECT COUNT(*) FROM steal_events
                        WHERE account_history_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?) AS todayCount
            `).get(accountHistoryId, accountHistoryId, startMs, endMs) as Pick<StealHistoryPage, 'todayCount' | 'totalCount'>;
            const events = connection.prepare(`
                WITH page AS (
                    SELECT event_id, friend_gid, friend_name, occurred_at_ms, trigger_type
                    FROM steal_events
                    WHERE ${conditions.join(' AND ')}
                    ORDER BY occurred_at_ms DESC, event_id DESC
                    LIMIT ?
                ),
                friend_counts AS (
                    SELECT friend_gid, COUNT(*) AS friendTotalCount,
                           COUNT(CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN 1 END) AS friendTodayCount
                    FROM steal_events
                    WHERE account_history_id = ? AND friend_gid IN (SELECT DISTINCT friend_gid FROM page)
                    GROUP BY friend_gid
                )
                SELECT page.event_id AS eventId, page.friend_gid AS friendGid, page.friend_name AS friendName,
                       page.occurred_at_ms AS occurredAtMs, page.trigger_type AS triggerType,
                       friend_counts.friendTodayCount, friend_counts.friendTotalCount,
                       COALESCE(progress.skipped_count, 0) AS friendSkippedCount
                FROM page JOIN friend_counts USING (friend_gid)
                LEFT JOIN friend_steal_progress AS progress
                    ON progress.account_history_id = ? AND progress.friend_gid = page.friend_gid
                ORDER BY page.occurred_at_ms DESC, page.event_id DESC
            `).all(...pageParams, limit + 1, startMs, endMs, accountHistoryId, accountHistoryId) as StealHistoryEntry[];
            return { events, todayCount, totalCount };
        })();

        const summary = { todayCount, totalCount, timeZone };
        if (events.length <= limit) return { items: events, nextCursor: null, ...summary };
        const items = events.slice(0, limit);
        const { eventId, occurredAtMs } = items[items.length - 1];
        const nextCursor = Buffer.from(JSON.stringify({ eventId, occurredAtMs })).toString('base64url');
        return { items, nextCursor, ...summary };
    }

    return {
        write,
        list,
        analyze: (accountHistoryId: string, options: StealAnalysisRange, nowMs = Date.now()) =>
            readStealAnalysis(getDatabase(), accountHistoryId, options, nowMs),
        analyzeFriend: (accountHistoryId: string, friendGid: string, options: StealAnalysisRange, nowMs = Date.now()) =>
            readFriendStealAnalysis(getDatabase(), accountHistoryId, friendGid, options, nowMs),
        shouldSkipStealRound,
        resetStealProgress,
        close() {
            db?.close();
            db = undefined;
        },
    };
}
