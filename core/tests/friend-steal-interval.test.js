const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hasFriendFarmTurnover } = require('../dist/services/friend/steal-round');
const { createStealHistoryStore } = require('../dist/services/steal-history-store');

function loadModule(file, overrides) {
    const filename = path.resolve(__dirname, '../dist', file);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const load = new Function('require', 'module', 'exports', '__dirname', readFileSync(filename, 'utf8'));
    load(name => overrides[name] ?? localRequire(name), module, module.exports, path.dirname(filename));
    return module.exports;
}

function loadInterval(store, logWarn = () => {}) {
    const interval = loadModule('services/friend/steal-interval.js', {
        '../steal-history-store': { createStealHistoryStore: () => store },
        '../../utils/utils': { logWarn },
    });
    interval.configureFriendStealInterval('account-a');
    return interval;
}

function crop(phaseStartedAt, { plantId = 20001, season = 1, phase = 6 } = {}) {
    return { plantId, season, phase, phaseStartedAt };
}

test('only a comparable original plot can establish a new farm round', () => {
    const previous = { 1: crop(100), 2: crop(80, { phase: 2 }) };
    for (const current of [
        {},
        { 1: crop(100), 2: crop(80, { phase: 2 }), 3: crop(120) },
        { 1: crop(100), 2: crop(120) },
        { 1: crop(0, { season: 0 }), 2: crop(80, { phase: 2 }) },
        { 1: crop(120, { phase: 0 }), 2: crop(80, { phase: 2 }) },
        { 1: crop(120, { phase: 7 }), 2: crop(80, { phase: 2 }) },
        { 1: crop(90) },
    ]) {
        assert.equal(hasFriendFarmTurnover(previous, current), false, JSON.stringify(current));
    }
    for (const current of [
        { 1: crop(110) },
        { 1: crop(100, { season: 2 }) },
        { 1: crop(110, { phase: 1 }) },
        { 2: crop(110, { plantId: 20002, phase: 2 }) },
    ]) {
        assert.equal(hasFriendFarmTurnover(previous, current), true, JSON.stringify(current));
    }
});

test('auto visits skip distinct eligible farm rounds and reset once after a successful reply', async (t) => {
    const store = createStealHistoryStore(':memory:');
    t.after(() => store.close());
    const resets = [];
    const interval = loadInterval({
        ...store,
        resetStealProgress(accountId, gid, round) {
            resets.push(gid);
            store.resetStealProgress(accountId, gid, round);
        },
    });
    const primaryGid = '9007199254740993';
    function land(id, phase = 6, stealable = true, begin_time = 100) {
        return { id, plant: { id: 20001, season: 1, phases: [{ phase, begin_time }], stealable } };
    }
    let lands = [land(1), land(2), { id: 3 }];
    let plantBlacklist = [];
    let friendBlacklist = [];
    let stealEnabled = true;
    let enterFails = false;
    let harvest = () => {};
    let skipCount = 2;
    const events = [];
    const requests = [];
    const visit = loadModule('services/friend/visit-strategy.js', {
        '../../config/config': { PlantPhase: { MATURE: 6, DEAD: 7 } },
        '../../config/gameConfig': { getPlantName: () => '草莓', getPlantById: () => ({ seed_id: 123 }) },
        '../../models/store': {
            getPlantBlacklist: () => plantBlacklist,
            getFriendBlacklist: () => friendBlacklist,
            getFriendStealSkipCount: () => skipCount,
            isAutomationOn: key => key === 'friend_help' || (key === 'friend_steal' && stealEnabled),
        },
        '../../utils/network': {
            getUserState: () => ({ gid: 1, accountId: '1' }),
            networkEvents: new EventEmitter(),
        },
        '../../utils/utils': { toNum: Number, toTimeSec: Number, log() {}, logWarn() {}, sleep: async () => {}, randomDelay: async () => {} },
        '../farm': {
            getCurrentPhase: phases => phases[0], buildLandMap: () => new Map(), isOccupiedSlaveLand: () => false,
            getPlantStatusFlags: () => ({ needWater: true }),
        },
        '../career': {},
        '../stats': { recordOperation() {} },
        '../warehouse': { sellAllFruits: async () => {} },
        './api': {
            enterFriendFarm: async gid => {
                if (enterFails) throw new Error('进入失败');
                return { basic: { gid: gid === 42 ? BigInt(primaryGid) : gid }, lands };
            },
            leaveFriendFarm: async () => {},
            stealHarvest: async (gid, ids) => {
                requests.push([gid, ids]);
                return harvest(ids);
            },
            helpFarming: async (_gid, ids) => ({
                effect: 'confirmed', operationCount: ids.length, landCount: ids.length, landIds: ids, dogSkillGiftCount: 0,
            }),
        },
        './gid-manager': {
            parseRpcErrorCode: () => 0,
            isInvalidFriendAccessError: () => false,
            postToMaster: ({ data }) => {
                events.push(data);
                store.write('1', 'account-a', data);
            },
        },
        './pet-cache': {},
        './scheduler': { setCanGetHelpExp() {} },
        './steal-interval': interval,
    });
    async function auto(gid = 42) {
        const totals = { steal: 0, farming: 0 };
        await visit.visitFriend({ gid, name: '好友' }, totals, 1, '1');
        return totals;
    }
    function skipped() {
        return store.list('account-a', 1, null, { friendGid: primaryGid }).items[0].friendSkippedCount;
    }

    assert.equal((await auto()).steal, 2);
    assert.equal((await auto(43)).steal, 2);
    assert.deepEqual(resets, [primaryGid, '43']);
    assert.deepEqual(requests, [[42, [1, 2]], [43, [1, 2]]]);

    lands = [land(1, 6, false, 200)];
    assert.equal((await auto()).steal, 0);
    lands = [land(1, 6, true, 200), land(2)];
    plantBlacklist = [123];
    assert.equal((await auto()).steal, 0);
    plantBlacklist = [];
    friendBlacklist = [42];
    assert.equal((await auto()).steal, 0);
    friendBlacklist = [];
    enterFails = true;
    assert.equal((await auto()).steal, 0);
    enterFails = false;
    stealEnabled = false;
    assert.equal((await auto()).steal, 0);
    stealEnabled = true;
    assert.equal(skipped(), 0);

    lands[0] = land(1);
    lands.push(land(3, 2, false));
    assert.deepEqual(await auto(), { steal: 0, farming: 1 });
    assert.equal(skipped(), 0);
    lands[0] = land(1, 6, true, 200);
    for (let i = 0; i < 3; i++) {
        lands[0].plant.left_fruit_num = 8 - i;
        assert.equal((await auto()).steal, 0);
        assert.equal(skipped(), 1);
    }
    assert.deepEqual(requests, [[42, [1, 2]], [43, [1, 2]]]);
    assert.equal(events.length, 2);
    assert.equal((await visit.doFriendOperation('42', 'steal')).count, 2);
    assert.equal(events.at(-1).triggerType, 'manual');
    assert.equal((await auto()).steal, 0);
    assert.equal(skipped(), 1);
    assert.equal(events.length, 3);

    lands[0].plant.season = 2;
    assert.equal((await auto()).steal, 0);
    assert.equal((await auto()).steal, 0);
    assert.equal(skipped(), 2);

    lands[0] = land(1, 6, true, 300);
    harvest = () => { throw new Error('Harvest failed'); };
    const firstFailure = requests.length;
    assert.equal((await auto()).steal, 0);
    assert.deepEqual(requests.slice(firstFailure), [[42, [1, 2]], [42, [1]], [42, [2]]]);
    assert.deepEqual(resets, [primaryGid, '43']);
    assert.equal(events.length, 3);
    assert.equal(skipped(), 2);

    harvest = ids => {
        if (ids.length > 1) throw new Error('Batch failed');
    };
    const firstFallback = requests.length;
    assert.equal((await auto()).steal, 2);
    assert.deepEqual(requests.slice(firstFallback), [[42, [1, 2]], [42, [1]], [42, [2]]]);
    assert.deepEqual(resets, [primaryGid, '43', primaryGid]);
    assert.equal(events.length, 4);
    assert.equal(events.at(-1).friendGid, primaryGid);
    assert.equal(skipped(), 0);

    skipCount = 1;
    lands[0] = land(1, 6, true, 400);
    assert.equal((await auto()).steal, 0);
    assert.equal((await auto()).steal, 0);
    assert.equal(skipped(), 1);
    lands[0] = land(1, 6, true, 500);
    assert.equal((await auto()).steal, 2);
    skipCount = 0;
    assert.equal((await auto()).steal, 2);
    assert.equal((await auto()).steal, 2);
    assert.equal(resets.length, 4);
});

test('restart, midnight and configuration changes preserve skipped rounds by account generation', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-steal-interval-'));
    const file = path.join(dir, 'steal-history.db');
    const first = createStealHistoryStore(file);
    const second = createStealHistoryStore(file);
    t.after(() => {
        first.close();
        second.close();
        rmSync(dir, { recursive: true, force: true });
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T23:59:59+08:00') });
    const round = time => ({ 1: crop(time) });
    const interval = loadInterval(first);
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(100)), false);
    interval.recordAutoStealSuccess('42', round(100));
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(200)), true);
    assert.equal(interval.shouldSkipAutoSteal('43', 2, round(100)), false);
    first.close();

    t.mock.timers.tick(2000);
    const restarted = loadInterval(second);
    assert.equal(restarted.shouldSkipAutoSteal('42', 0, round(200)), false);
    assert.equal(restarted.shouldSkipAutoSteal('42', 0, round(300)), false);
    restarted.configureFriendStealInterval('account-b');
    assert.equal(restarted.shouldSkipAutoSteal('42', 2, round(200)), false);
    restarted.configureFriendStealInterval('account-a');
    assert.equal(restarted.shouldSkipAutoSteal('42', 1, round(200)), true);
    assert.equal(restarted.shouldSkipAutoSteal('42', 3, round(300)), true);
    assert.equal(restarted.shouldSkipAutoSteal('42', 3, round(400)), true);
    assert.equal(restarted.shouldSkipAutoSteal('42', 3, round(400)), true);
    assert.equal(restarted.shouldSkipAutoSteal('42', 3, round(500)), false);
});

test('database failures suppress automatic stealing and retry a failed reset before resuming', (t) => {
    const store = createStealHistoryStore(':memory:');
    t.after(() => store.close());
    let unavailable = true;
    const warnings = [];
    const interval = loadInterval({
        shouldSkipStealRound(...args) {
            if (unavailable) throw new Error('database unavailable');
            return store.shouldSkipStealRound(...args);
        },
        resetStealProgress(...args) {
            if (unavailable) throw new Error('database unavailable');
            store.resetStealProgress(...args);
        },
    }, (...args) => warnings.push(args));

    const round = time => ({ 1: crop(time) });
    assert.equal(interval.shouldSkipAutoSteal('42', 0, round(100)), false);
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(100)), true);
    assert.equal(warnings.length, 1);
    unavailable = false;
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(100)), false);
    unavailable = true;
    interval.recordAutoStealSuccess('42', round(100));
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(200)), true);
    assert.equal(warnings.length, 3);
    unavailable = false;
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(200)), true);
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(300)), true);
    assert.equal(interval.shouldSkipAutoSteal('42', 2, round(400)), false);
});

test('settings validate and save the account value before applying it to the Worker', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-steal-settings-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    function loadAccountConfig() {
        const sharedState = loadModule('models/store/shared-state.js', {
            '../../config/runtime-paths': { getDataFile: name => path.join(dir, name) },
        });
        return loadModule('models/store/account-config.js', {
            './shared-state': sharedState,
            './global-config': {},
        });
    }
    const store = loadAccountConfig();
    const workerStore = loadAccountConfig();
    const offlineReminder = { offlineDeleteSec: 60 };
    const { createDataProvider } = require('../dist/runtime/data-provider');
    const { mountAccountRoutes } = loadModule('controllers/admin/account-routes.js', {
        '../../models/store': { ...store, getUI: () => ({}), getOfflineReminder: () => offlineReminder },
    });
    let revision = 0;
    let workerCalls = 0;
    const provider = createDataProvider({
        workers: { 1: {} },
        store,
        getAccounts: () => ({ accounts: [{ id: '1' }, { id: '2' }] }),
        nextConfigRevision: () => ++revision,
        buildConfigSnapshotForAccount: id => ({ ...store.getConfigSnapshot(id), __revision: revision }),
        callWorkerApi: async (id, method, snapshot) => {
            assert.equal(method, 'applyRuntimeConfigSnapshot');
            assert.equal(id, '1');
            workerStore.applyConfigSnapshot(snapshot, { accountId: id, persist: false });
            workerCalls++;
            return { appliedRevision: snapshot.__revision };
        },
    });
    const routes = new Map();
    mountAccountRoutes({
        get: (route, handler) => routes.set(`GET ${route}`, handler),
        post: (route, handler) => routes.set(`POST ${route}`, handler),
        put() {}, delete() {},
    }, { provider });
    async function request(route, body, id = '1') {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
        };
        await routes.get(route)({ headers: { 'x-account-id': id }, body }, res);
        return res;
    }
    const initialSettings = (await request('GET /api/settings')).body.data;
    assert.equal(initialSettings.friendStealSkipCount, 0);
    assert.deepEqual(initialSettings.offlineReminder, offlineReminder);
    const saved = await request('POST /api/settings/save', { friendStealSkipCount: 2 });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.confirmed, true);
    assert.equal(saved.body.data.friendStealSkipCount, 2);
    assert.equal(workerStore.getFriendStealSkipCount('1'), 2);
    assert.equal((await request('GET /api/settings')).body.data.friendStealSkipCount, 2);
    assert.equal((await request('GET /api/settings', undefined, '2')).body.data.friendStealSkipCount, 0);
    const configFile = path.join(dir, 'account-configs', '1.json');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).friendStealSkipCount, 2);

    for (const invalid of [-1, 1.5, '', '2', null, true, Number.MAX_SAFE_INTEGER + 1]) {
        const response = await request('POST /api/settings/save', { friendStealSkipCount: invalid });
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'INVALID_FRIEND_STEAL_SKIP_COUNT');
    }
    assert.equal(workerCalls, 1);
    assert.equal(revision, 1);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).friendStealSkipCount, 2);
    assert.equal((await request('POST /api/settings/save', { friendStealSkipCount: 0 })).body.confirmed, true);
    assert.equal(workerStore.getFriendStealSkipCount('1'), 0);
});
