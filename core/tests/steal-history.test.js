const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createStealHistoryRecorder } = require('../dist/services/friend/steal-history');
const { createStealHistoryStore, parseStealHistoryCursor } = require('../dist/services/steal-history-store');
const { getRuntimeConfig, updateRuntimeConfig } = require('../dist/config/config');

function loadModule(file, overrides) {
    const filename = path.resolve(__dirname, '../dist', file);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const load = new Function('require', 'module', 'exports', '__dirname', readFileSync(filename, 'utf8'));
    load(name => overrides[name] ?? localRequire(name), module, module.exports, path.dirname(filename));
    return module.exports;
}

test('finishing the same successful operation twice reports only one event', async () => {
    const events = [];
    const recorder = createStealHistoryRecorder('9007199254740993', '好友', 'auto', event => events.push(event));

    await recorder.capture(async () => {});
    await assert.rejects(recorder.capture(async () => { throw new Error('later request failed'); }), /later request failed/);
    recorder.finish();
    recorder.finish();
    assert.equal(events.length, 1);
    const { occurredAtMs, eventId, ...details } = events[0];
    assert.ok(occurredAtMs > 0);
    assert.match(eventId, /^[\da-f-]{36}$/);
    assert.deepEqual(details, { friendGid: '9007199254740993', friendName: '好友', triggerType: 'auto' });
});

test('manual operations, auto batches and fallback record once each, and failed visits record nothing', async () => {
    let harvest = () => {};
    const trace = [];
    const events = [];
    const calls = [];
    const land = id => ({ id, plant: { id: 20001, phases: [{ phase: 6 }], stealable: true } });
    const visit = loadModule('services/friend/visit-strategy.js', {
        '../../config/config': { PlantPhase: { MATURE: 6 } },
        '../../config/gameConfig': { getPlantName: () => '草莓', getPlantById: () => ({ seed_id: 123 }) },
        '../../models/store': {
            getPlantBlacklist: () => [],
            getFriendBlacklist: () => [],
            getFriendStealSkipCount: () => 0,
            isAutomationOn: key => key === 'friend_steal',
        },
        '../../utils/network': { getUserState: () => ({ gid: 1, accountId: '1' }) },
        '../../utils/utils': { toNum: Number, toTimeSec: Number, log() {}, logWarn() {}, sleep: async () => {}, randomDelay: async () => {} },
        '../farm': { getCurrentPhase: phases => phases[0], buildLandMap: () => new Map(), isOccupiedSlaveLand: () => false },
        '../career': {},
        '../stats': { recordOperation: (type, count) => trace.push([type, count]) },
        '../warehouse': { sellAllFruits: async () => { trace.push('sell'); } },
        './api': {
            enterFriendFarm: async () => ({ basic: { gid: 9007199254740993n, name: '实际好友' }, lands: [land(1), land(2), land(3)] }),
            leaveFriendFarm: async () => {},
            stealHarvest: async (_gid, ids) => {
                calls.push(Array.from(ids));
                return harvest(ids);
            },
        },
        './gid-manager': { postToMaster: ({ data }) => { events.push(data); trace.push('report'); } },
        './pet-cache': {},
        './scheduler': { setCanGetHelpExp() {} },
    });

    const manual = await visit.doFriendOperation('123', 'steal');
    assert.equal(manual.count, 3);
    assert.deepEqual(trace, ['report', ['steal', 3], 'sell']);
    assert.equal(events.length, 1);
    assert.equal(events[0].triggerType, 'manual');
    assert.equal(events[0].friendGid, '9007199254740993');
    assert.equal(events[0].friendName, '实际好友');

    calls.length = 0;
    const friend = { gid: 123, name: '列表名称' };
    const autoBatch = await visit.visitFriend(friend, { steal: 0 }, 1, '1');
    assert.equal(autoBatch.acted, true);
    assert.deepEqual(calls, [[1, 2, 3]]);
    assert.equal(events.length, 2);
    assert.equal(events[1].triggerType, 'auto');

    calls.length = 0;
    harvest = ids => {
        if (ids.length > 1) throw new Error('batch reply timed out');
    };
    const totalActions = { steal: 0 };
    const fallback = await visit.visitFriend(friend, totalActions, 1, '1');
    assert.equal(fallback.acted, true);
    assert.deepEqual(calls, [[1, 2, 3], [1], [2], [3]]);
    assert.equal(totalActions.steal, 3);
    assert.equal(events.length, 3);
    assert.equal(events[2].triggerType, 'auto');
    assert.equal(new Set(events.map(event => event.eventId)).size, 3);

    calls.length = 0;
    harvest = () => { throw new Error('harvest rejected'); };
    const failed = await visit.visitFriend(friend, { steal: 0 }, 1, '1');
    assert.equal(failed.acted, false);
    assert.deepEqual(calls, [[1, 2, 3], [1], [2], [3]]);
    assert.equal(events.length, 3);
});

test('SQLite counts legacy and new operations across pages, preserves legacy fruit rows, and isolates account generations', (t) => {
    const Database = require('libsql');
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-steal-history-'));
    const file = path.join(dir, 'steal-history.db');
    const history = createStealHistoryStore(file);
    t.after(() => {
        history.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const account = randomUUID();
    const newerAccount = randomUUID();
    const entry = {
        eventId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        occurredAtMs: 1_795_100_000_000,
        friendGid: '9007199254740993',
        friendName: '好友',
        triggerType: 'auto',
    };
    const legacy = new Database(file);
    try {
        legacy.exec(`
            CREATE TABLE steal_events (
                event_id TEXT NOT NULL PRIMARY KEY, account_id TEXT NOT NULL, account_history_id TEXT NOT NULL,
                friend_gid TEXT NOT NULL, friend_name TEXT, occurred_at_ms INTEGER NOT NULL, trigger_type TEXT NOT NULL,
                quantity_status TEXT NOT NULL CHECK (quantity_status IN ('confirmed', 'partial', 'unknown'))
            );
            CREATE TABLE steal_event_items (
                event_id TEXT NOT NULL REFERENCES steal_events(event_id) ON DELETE CASCADE,
                fruit_id INTEGER NOT NULL, fruit_name TEXT, quantity INTEGER NOT NULL,
                PRIMARY KEY (event_id, fruit_id)
            );
            CREATE TABLE friend_steal_progress (
                account_history_id TEXT NOT NULL, friend_gid TEXT NOT NULL,
                skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
                PRIMARY KEY (account_history_id, friend_gid)
            );
        `);
        legacy.prepare("INSERT INTO steal_events VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')")
            .run(entry.eventId, '1', account, entry.friendGid, entry.friendName, entry.occurredAtMs, entry.triggerType);
        legacy.prepare('INSERT INTO steal_event_items VALUES (?, ?, ?, ?)').run(entry.eventId, 100, '草莓', 7);
        legacy.prepare('INSERT INTO friend_steal_progress VALUES (?, ?, ?)').run(account, entry.friendGid, 1);
    } finally {
        legacy.close();
    }

    const tiedEntry = { ...entry, eventId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', friendName: '新昵称' };
    history.write('1', account, tiedEntry);
    history.write('1', account, { ...entry, friendName: '重复上报' });
    history.write('1', newerAccount, { ...entry, eventId: randomUUID() });
    const round = time => ({ 1: { plantId: 20001, season: 1, phase: 6, phaseStartedAt: time } });
    assert.equal(history.shouldSkipStealRound(newerAccount, entry.friendGid, 2, round(100)), false);
    assert.equal(history.shouldSkipStealRound(account, entry.friendGid, 1, round(100)), true);
    assert.equal(history.list(account, 1, null).items[0].friendSkippedCount, 1);
    history.close();
    assert.equal(history.shouldSkipStealRound(account, entry.friendGid, 1, round(100)), true);
    assert.equal(history.shouldSkipStealRound(account, entry.friendGid, 1, round(200)), false);
    assert.equal(history.shouldSkipStealRound(account, entry.friendGid, 2, round(200)), true);
    assert.equal(history.shouldSkipStealRound(account, entry.friendGid, 2, round(300)), false);

    const nowMs = entry.occurredAtMs;
    const timeZone = getRuntimeConfig().timeZone;
    const first = history.list(account, 1, null, {}, nowMs);
    assert.deepEqual(first.items, [{ ...tiedEntry, friendTodayCount: 2, friendTotalCount: 2, friendSkippedCount: 2 }]);
    assert.equal(first.todayCount, 2);
    assert.equal(first.totalCount, 2);
    assert.ok(first.nextCursor);
    const second = history.list(account, 1, parseStealHistoryCursor(first.nextCursor), {}, nowMs);
    assert.deepEqual(second, {
        items: [{ ...entry, friendTodayCount: 2, friendTotalCount: 2, friendSkippedCount: 2 }],
        nextCursor: null, todayCount: 2, totalCount: 2, timeZone,
    });
    assert.deepEqual(history.list(account, 1, entry, {}, nowMs), { items: [], nextCursor: null, todayCount: 2, totalCount: 2, timeZone });
    const reusedAccount = history.list(newerAccount, 30, null, {}, nowMs);
    assert.equal(reusedAccount.todayCount, 1);
    assert.equal(reusedAccount.items[0].friendTotalCount, 1);
    assert.equal(reusedAccount.items[0].friendSkippedCount, 0);
    history.resetStealProgress(account, entry.friendGid, round(300));
    assert.equal(history.list(account, 1, null, { friend: entry.friendGid }, nowMs).items[0].friendSkippedCount, 0);
    assert.deepEqual(history.list(randomUUID(), 30, null, {}, nowMs), { items: [], nextCursor: null, todayCount: 0, totalCount: 0, timeZone });
    assert.equal(parseStealHistoryCursor('invalid'), null);

    const persisted = new Database(file);
    try {
        assert.deepEqual(persisted.prepare('SELECT event_id, quantity FROM steal_event_items').all(), [
            { event_id: entry.eventId, quantity: 7 },
        ]);
        const newRow = persisted.prepare('SELECT quantity_status FROM steal_events WHERE event_id = ?').get(tiedEntry.eventId);
        assert.equal(newRow.quantity_status, 'unknown');
    } finally {
        persisted.close();
    }
});

test('a fresh SQLite store can count operations with just the event table', (t) => {
    const history = createStealHistoryStore(':memory:');
    t.after(() => history.close());
    const timeZone = getRuntimeConfig().timeZone;
    assert.deepEqual(history.list('new-account', 30, null), { items: [], nextCursor: null, todayCount: 0, totalCount: 0, timeZone });
    const event = { eventId: randomUUID(), occurredAtMs: Date.now(), friendGid: '42', friendName: null, triggerType: 'manual' };
    history.write('1', 'new-account', event);
    assert.deepEqual(history.list('new-account', 30, null, {}, event.occurredAtMs), {
        items: [{ ...event, friendTodayCount: 1, friendTotalCount: 1, friendSkippedCount: 0 }],
        nextCursor: null, todayCount: 1, totalCount: 1, timeZone,
    });
});

test('today uses the configured time zone, including midnight and both DST transitions', (t) => {
    const previousTimeZone = getRuntimeConfig().timeZone;
    const history = createStealHistoryStore(':memory:');
    t.after(() => {
        updateRuntimeConfig({ timeZone: previousTimeZone });
        history.close();
    });

    const days = [
        ['Asia/Shanghai', '2026-11-18T16:00:00Z', '2026-11-19T16:00:00Z'],
        ['America/New_York', '2025-03-09T05:00:00Z', '2025-03-10T04:00:00Z'],
        ['America/New_York', '2025-11-02T04:00:00Z', '2025-11-03T05:00:00Z'],
    ];
    for (const [timeZone, start, end] of days) {
        updateRuntimeConfig({ timeZone });
        const account = randomUUID();
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        for (const occurredAtMs of [startMs - 1, startMs, endMs - 1, endMs]) {
            history.write('1', account, { eventId: randomUUID(), occurredAtMs, friendGid: '42', friendName: null, triggerType: 'auto' });
        }
        history.write('1', account, {
            eventId: randomUUID(), occurredAtMs: startMs - 2, friendGid: '43', friendName: null, triggerType: 'manual',
        });
        history.write('2', randomUUID(), {
            eventId: randomUUID(), occurredAtMs: startMs, friendGid: '42', friendName: null, triggerType: 'auto',
        });

        const page = history.list(account, 1, null, {}, endMs - 1);
        assert.equal(page.timeZone, timeZone);
        assert.equal(page.todayCount, 2);
        assert.equal(page.totalCount, 5);
        assert.equal(page.items[0].friendTodayCount, 2);
        assert.equal(page.items[0].friendTotalCount, 4);
        const lastPage = history.list(account, 2, { occurredAtMs: startMs, eventId: '' }, {}, endMs - 1);
        assert.deepEqual(lastPage.items.map(item => [item.friendGid, item.friendTodayCount, item.friendTotalCount]), [
            ['42', 2, 4], ['43', 0, 1],
        ]);
        assert.equal(lastPage.todayCount, 2);
        assert.equal(history.list(account, 1, null, {}, endMs).todayCount, 1);
    }
});

test('friend, trigger and inclusive calendar dates filter the account history before pagination', (t) => {
    const history = createStealHistoryStore(':memory:');
    const previousTimeZone = getRuntimeConfig().timeZone;
    updateRuntimeConfig({ timeZone: 'America/New_York' });
    t.after(() => {
        updateRuntimeConfig({ timeZone: previousTimeZone });
        history.close();
    });

    const account = randomUUID();
    const friendGid = '9007199254740993';
    const start = Date.parse('2025-03-09T05:00:00Z');
    const end = Date.parse('2025-03-11T04:00:00Z');
    const entries = [
        { occurredAtMs: start - 1, friendName: 'Ab_李' },
        { occurredAtMs: start, friendName: 'Ab_李' },
        { occurredAtMs: end - 1, friendName: '新 Ab_李' },
        { occurredAtMs: end, friendName: 'Ab_李' },
        { occurredAtMs: end - 2, friendName: 'Ab_李', triggerType: 'manual' },
        { occurredAtMs: end - 3, friendName: 'AbX李', friendGid: '51' },
        { occurredAtMs: end - 4, friendName: null },
    ].map(entry => ({ eventId: randomUUID(), friendGid, triggerType: 'auto', ...entry }));
    for (const entry of entries) history.write('1', account, entry);
    history.write('2', randomUUID(), { ...entries[2], eventId: randomUUID() });

    const filters = { friend: 'ab_', triggerType: 'auto', fromDate: '2025-03-09', toDate: '2025-03-10' };
    const first = history.list(account, 1, null, filters, end - 1);
    assert.equal(first.items[0].eventId, entries[2].eventId);
    assert.equal(first.totalCount, 7);
    assert.equal(first.items[0].friendTotalCount, 6);
    const second = history.list(account, 1, parseStealHistoryCursor(first.nextCursor), filters, end - 1);
    assert.deepEqual(second.items.map(item => item.eventId), [entries[1].eventId]);
    assert.equal(second.nextCursor, null);

    const byGid = history.list(account, 30, null, { friend: friendGid, fromDate: '2025-03-11' }, end);
    assert.deepEqual(byGid.items.map(item => item.eventId), [entries[3].eventId]);
    const withoutName = history.list(account, 30, null, { friend: friendGid, toDate: '2025-03-10' }, end);
    assert.ok(withoutName.items.some(item => item.eventId === entries[6].eventId));
});

test('legacy accounts get stable history IDs and reusing a panel ID gets a new history ID', () => {
    let disk = { accounts: [{ id: '1', name: '旧账号' }], nextId: 2 };
    let writes = 0;
    const loadAccounts = () => loadModule('models/store/accounts.js', {
        '../../config/runtime-paths': { ensureDataDir() {} },
        '../../services/json-db': {
            readJsonFileStrict: () => structuredClone(disk),
            writeJsonFileAtomic: (_file, data) => { disk = structuredClone(data); writes++; },
        },
        './shared-state': { ACCOUNTS_FILE: 'synthetic' },
        './account-config': { ensureAccountConfig() {}, removeAccountConfig() {} },
    });

    const oldId = loadAccounts().getAccounts().accounts[0].historyId;
    assert.equal(writes, 1);
    const store = loadAccounts();
    assert.equal(store.getAccounts().accounts[0].historyId, oldId);
    assert.equal(writes, 1);
    assert.equal(store.addOrUpdateAccount({ id: '1', name: '新备注', historyId: 'ignored' }).accounts[0].historyId, oldId);
    store.deleteAccount('1');
    const [newAccount] = store.addOrUpdateAccount({ name: '新账号' }).accounts;
    assert.equal(newAccount.id, '1');
    assert.notEqual(newAccount.historyId, oldId);
});

test('worker routing uses the launch account identity instead of the payload', () => {
    const { createWorkerManager } = require('../dist/runtime/worker-manager');
    const workers = {};
    const events = [];
    const commands = [];
    class Child extends EventEmitter {
        postMessage(message) { commands.push(message); }
    }
    const manager = createWorkerManager({
        WorkerThread: Child,
        processRef: process,
        workerScriptPath: 'synthetic.js',
        workers,
        globalLogs: [],
        log() {},
        addAccountLog() {},
        buildConfigSnapshotForAccount: () => ({}),
        onStealHistory: (...args) => events.push(args),
    });
    manager.startWorker({ id: '1', historyId: 'launch-instance' });
    assert.equal(commands.find(message => message.type === 'start').config.accountHistoryId, 'launch-instance');
    const data = { eventId: randomUUID(), accountId: '2', historyId: 'from-payload' };
    workers[1].process.emit('message', { type: 'steal_history', data });
    assert.deepEqual(events, [['1', 'launch-instance', data]]);
});

test('history API requires auth and a valid account, queries stopped accounts, and reports storage outages', () => {
    const { mountAuthRoutes } = loadModule('controllers/admin/auth-routes.js', {
        '../../models/admin-store': {},
        '../../services/logger': { createModuleLogger: () => ({}) },
    });
    const { mountFarmRoutes } = require('../dist/controllers/admin/farm-routes');
    const { createDataProvider } = require('../dist/runtime/data-provider');
    const listCalls = [];
    const entry = {
        eventId: randomUUID(), occurredAtMs: 1_795_100_000_000, friendGid: '42', friendName: '好友', triggerType: 'auto',
        friendTodayCount: 2, friendTotalCount: 6, friendSkippedCount: 1,
    };
    let dbAvailable = true;
    const ctx = {
        tokens: new Set(['test-token']),
        provider: createDataProvider({
            workers: {},
            getAccounts: () => ({ accounts: [{ id: '1', historyId: 'test-history-id' }] }),
            listStealHistory: (...args) => {
                if (!dbAvailable) throw new Error('could not open SQLite');
                listCalls.push(args);
                return { items: [entry], nextCursor: 'next', todayCount: 4, totalCount: 37, timeZone: 'Asia/Shanghai' };
            },
        }),
    };
    const routes = new Map();
    let authenticate;
    const app = {
        use(prefix, handler) { if (prefix === '/api') authenticate = handler; },
        get(route, handler) { routes.set(route, handler); },
        post() {},
        put() {},
        delete() {},
    };
    mountAuthRoutes(app, ctx);
    mountFarmRoutes(app, ctx);

    function request(headers, query = {}) {
        const req = { path: '/analytics/steal-history', headers, query, get: key => headers[key] };
        const res = {
            statusCode: 200,
            set() {},
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        };
        authenticate(req, res, () => routes.get('/api/analytics/steal-history')(req, res));
        return res;
    }

    assert.equal(request({ 'x-account-id': '1' }).statusCode, 401);
    const auth = { 'x-admin-token': 'test-token' };
    assert.equal(request(auth).statusCode, 400);
    assert.equal(request({ ...auth, 'x-account-id': 'deleted' }).statusCode, 404);
    const headers = { ...auth, 'x-account-id': '1' };
    assert.equal(request(headers, { cursor: 'malformed' }).statusCode, 400);
    assert.equal(request(headers, { limit: '101' }).statusCode, 400);
    for (const query of [
        { triggerType: 'everything' }, { friend: ['a', 'b'] }, { fromDate: '2025-02-29' },
        { fromDate: '2025-03-10', toDate: '2025-03-09' },
    ]) {
        assert.equal(request(headers, query).statusCode, 400);
    }
    assert.deepEqual(request(headers).body, {
        ok: true,
        data: {
            items: [{ ...entry, quantityStatus: 'unknown', fruits: [] }],
            nextCursor: 'next',
            todayCount: 4,
            totalCount: 37,
            timeZone: 'Asia/Shanghai',
        },
    });
    assert.deepEqual(listCalls, [[
        'test-history-id', 30, null, { friend: undefined, triggerType: undefined, fromDate: undefined, toDate: undefined },
    ]]);
    assert.equal(request(headers, { friend: ' 42 ', triggerType: 'manual', fromDate: '2024-02-29' }).statusCode, 200);
    assert.deepEqual(listCalls[1], [
        'test-history-id', 30, null, { friend: '42', triggerType: 'manual', fromDate: '2024-02-29', toDate: undefined },
    ]);
    dbAvailable = false;
    assert.equal(request(headers).statusCode, 503);
});

test('a SQLite write error is logged without interrupting the worker message handler', () => {
    class Child extends EventEmitter {
        postMessage() {}
    }
    const { createRuntimeEngine } = loadModule('runtime/runtime-engine.js', {
        'node:worker_threads': { Worker: Child },
        '../models/store': { getConfigSnapshot: () => ({}) },
        '../services/steal-history-store': {
            createStealHistoryStore: () => ({
                write() { throw new Error('test database unavailable'); },
                list() {},
            }),
        },
    });
    const logs = [];
    const runtime = createRuntimeEngine({ processRef: process, workerScriptPath: 'synthetic.js', onLog: entry => logs.push(entry) });
    assert.equal(runtime.startWorker({ id: '1', name: '测试', historyId: 'test-history-id' }), true);
    const worker = runtime.workers['1'].process;
    assert.doesNotThrow(() => worker.emit('message', { type: 'steal_history', data: {} }));
    assert.ok(logs.some(entry => entry.accountId === '1' && entry.msg.includes('保存偷菜记录失败')));
    assert.doesNotThrow(() => worker.emit('message', { type: 'log', data: { msg: 'still running' } }));
    assert.equal(logs.at(-1).msg, 'still running');
});
