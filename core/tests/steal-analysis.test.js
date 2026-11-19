const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createStealHistoryStore, parseStealHistoryCursor } = require('../dist/services/steal-history-store');
const { getRuntimeConfig, updateRuntimeConfig } = require('../dist/config/config');

function fixture(t, timeZone) {
    const directory = mkdtempSync(join(tmpdir(), 'farm-steal-analysis-'));
    const store = createStealHistoryStore(join(directory, 'history.db'));
    const priorConfig = getRuntimeConfig();
    updateRuntimeConfig({ timeZone });
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
        updateRuntimeConfig(priorConfig);
    });
    function write(date, friendGid, friendName, triggerType = 'auto', historyId = 'first-generation') {
        const event = { eventId: randomUUID(), occurredAtMs: Date.parse(date), friendGid, friendName, triggerType };
        store.write('same-panel-account', historyId, event);
        return event;
    }
    return { store, write };
}

test('overview uses the full period and friend detail uses exact string GIDs', (t) => {
    const { store, write } = fixture(t, 'Asia/Shanghai');
    const now = Date.parse('2026-11-19T15:59:59.999Z');
    const gid = '9007199254740993';
    write('2026-09-30T00:00:00Z', '60', '旧好友');
    write('2026-11-12T15:59:59.999Z', gid, '曾用名');
    write('2026-11-12T16:00:00Z', gid, '曾用名');
    write('2026-11-15T12:30:00Z', gid, '新昵称', 'manual');
    const last = write('2026-11-19T15:59:59.999Z', gid, null);
    write('2026-11-19T16:00:00Z', '61', '次日好友');
    for (const [i, id] of ['47', '46', '45', '44', '43'].entries()) {
        write('2026-11-15T12:30:00Z', id, i === 0 ? gid : '新昵称');
    }
    write('2026-11-15T12:30:00Z', gid, '新账号', 'manual', 'second-generation');

    const options = { range: '7d' };
    const overview = store.analyze('first-generation', options, now);
    assert.deepEqual(overview.window, { fromDate: '2026-11-13', toDate: '2026-11-19', dayCount: 7, timeZone: 'Asia/Shanghai' });
    assert.deepEqual(overview.coverage, { count: 8, friendCount: 6, averageDailyCount: 8 / 7, topFiveShare: 7 / 8 });
    assert.deepEqual(overview.ranking.map(row => row.friendGid), [gid, '43', '44', '45', '46', '47']);
    assert.deepEqual(overview.ranking[0], {
        friendGid: gid, friendName: '新昵称', count: 3, autoCount: 2, manualCount: 1,
        totalCount: 4, lastOccurredAtMs: last.occurredAtMs,
    });
    assert.equal(overview.heatmap.length, 7);
    assert.ok(overview.heatmap.every(hours => hours.length === 24));
    assert.equal(overview.heatmap.flat().reduce((sum, count) => sum + count, 0), overview.coverage.count);
    assert.equal(overview.heatmap[4][0], 1);
    assert.equal(overview.heatmap[6][20], 6);
    assert.equal(overview.heatmap[3][23], 1);
    assert.equal(store.analyze('second-generation', options, now).ranking[0].friendName, '新账号');

    const earlier = { range: 'custom', fromDate: '2026-11-13', toDate: '2026-11-15' };
    const detail = store.analyzeFriend('first-generation', gid, earlier, now);
    assert.deepEqual(detail.friend, { ...overview.ranking[0], count: 2, autoCount: 1 });
    assert.equal(detail.activeDays, 2);
    assert.equal(detail.last7DaysCount, 3);
    assert.equal(detail.last30DaysCount, 4);
    assert.equal(detail.heatmap[6][20], 1);
    assert.equal(store.analyzeFriend('first-generation', '62', earlier, now), null);

    const filters = { friendGid: gid, fromDate: '2026-11-13', toDate: '2026-11-19' };
    const history = store.list('first-generation', 2, null, filters, now);
    assert.deepEqual(history.items.map(row => row.friendGid), [gid, gid]);
    assert.ok(history.nextCursor);
    assert.equal(store.list('first-generation', 2, parseStealHistoryCursor(history.nextCursor), filters, now).items.length, 1);
    assert.equal(store.list('first-generation', 30, null, { ...filters, triggerType: 'manual' }, now).items.length, 1);

    const all = store.analyze('first-generation', { range: 'all' }, now);
    assert.equal(all.window.fromDate, '2026-09-30');
    assert.equal(all.window.dayCount, 51);
    assert.equal(all.ranking.find(friend => friend.friendGid === '60').count, 1);
    assert.equal(all.coverage.count, 10);
    const empty = store.analyze('empty-generation', { range: 'all' }, now);
    assert.equal(empty.window.fromDate, null);
    assert.equal(empty.window.dayCount, 0);
    assert.deepEqual(empty.coverage, { count: 0, friendCount: 0, averageDailyCount: 0, topFiveShare: 0 });
    assert.deepEqual(empty.ranking, []);
});

test('a repeated clock hour on a daylight saving transition counts both occurrences', (t) => {
    const { store, write } = fixture(t, 'America/New_York');
    const now = Date.parse('2026-11-01T12:00:00Z');
    write('2026-11-01T03:59:59.999Z', '42', null);
    write('2026-11-01T04:00:00Z', '42', null);
    write('2026-11-01T05:30:00Z', '42', null);
    write('2026-11-01T06:30:00Z', '42', null);
    write('2026-11-02T04:59:59.999Z', '42', null);
    write('2026-11-02T05:00:00Z', '42', null);
    const detail = store.analyzeFriend('first-generation', '42', { range: 'today' }, now);
    assert.equal(detail.friend.count, 4);
    assert.equal(detail.activeDays, 1);
    assert.equal(detail.heatmap[6][0], 1);
    assert.equal(detail.heatmap[6][1], 2);
    assert.equal(detail.heatmap[6][23], 1);
});

test('analysis routes are authenticated, validate input, and query offline account generations', (t) => {
    const { store, write } = fixture(t, 'Asia/Shanghai');
    const { mountAuthRoutes } = require('../dist/controllers/admin/auth-routes');
    const { mountFarmRoutes } = require('../dist/controllers/admin/farm-routes');
    const { createDataProvider } = require('../dist/runtime/data-provider');
    write('2026-11-15T12:30:00Z', '42', '好友');
    const ctx = {
        tokens: new Set(['test-token']),
        provider: createDataProvider({
            workers: {},
            getAccounts: () => ({ accounts: [{ id: 'offline', historyId: 'first-generation' }] }),
            listStealHistory: store.list,
            analyzeStealHistory: store.analyze,
            analyzeFriendStealHistory: store.analyzeFriend,
        }),
    };
    const routes = new Map();
    let authenticate;
    const app = {
        use(prefix, handler) { if (prefix === '/api') authenticate = handler; },
        get(route, handler) { routes.set(route, handler); },
        post() {}, put() {}, delete() {},
    };
    mountAuthRoutes(app, ctx);
    mountFarmRoutes(app, ctx);

    const base = '/api/analytics/steal-analysis';
    const range = { range: 'custom', fromDate: '2026-11-15', toDate: '2026-11-15' };
    function request(route, headers, query = range, params = {}) {
        const req = { path: route.slice(4), headers, query, params, get: key => headers[key] };
        const res = {
            statusCode: 200,
            set() {},
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        };
        authenticate(req, res, () => routes.get(route)(req, res));
        return res;
    }
    const auth = { 'x-admin-token': 'test-token' };
    const headers = { ...auth, 'x-account-id': 'offline' };
    assert.equal(request(base, {}).statusCode, 401);
    assert.equal(request(base, auth).statusCode, 400);
    assert.equal(request(base, { ...auth, 'x-account-id': 'unknown' }).statusCode, 404);
    assert.equal(request(base, headers, { ...range, fromDate: '2026-02-29' }).statusCode, 400);
    assert.equal(request(base, headers, { ...range, fromDate: '2026-11-16' }).statusCode, 400);
    assert.equal(request(base, headers, { range: ['today', 'all'] }).statusCode, 400);
    assert.equal(request(base, headers).body.data.coverage.count, 1);
    const friendPath = `${base}/friends/:friendGid`;
    assert.equal(request(friendPath, headers, range, { friendGid: '0' }).statusCode, 400);
    assert.equal(request(friendPath, headers, range, { friendGid: '43' }).statusCode, 404);
    assert.equal(request(friendPath, headers, range, { friendGid: '42' }).body.data.activeDays, 1);
    const historyPath = '/api/analytics/steal-history';
    assert.equal(request(historyPath, headers, { friendGid: ['42', '43'] }).statusCode, 400);
    assert.equal(request(historyPath, headers, { friendGid: '42' }).body.data.items.length, 1);
});
