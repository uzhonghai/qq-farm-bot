import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { compileScript, parse } = require('vue/compiler-sfc')
const { effectScope, nextTick, reactive } = require('vue')
const ts = require('typescript')

function mount(t, filename, props) {
  const requests = []
  const api = { get: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })) }
  const source = readFileSync(new URL(`../src/components/${filename}`, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'steal-analysis-test' })
  const { outputText } = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  function requireImport(id) {
    if (id === '@/api')
      return { __esModule: true, default: api, getApiErrorMessage: (_error, fallback) => fallback }
    if (id.startsWith('naive-ui/') || id.endsWith('.vue'))
      return {}
    return require(id)
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(requireImport, module, module.exports)
  const scope = effectScope()
  const view = scope.run(() => module.exports.default.setup(props, { expose() {} }))
  t.after(() => scope.stop())
  async function finish(index, data) {
    requests[index].resolve({ data: { ok: true, data } })
    await nextTick()
  }
  return { requests, finish, view, scope }
}

const window = { fromDate: '2026-11-13', toDate: '2026-11-19', dayCount: 7, timeZone: 'Asia/Shanghai' }
const friendA = { friendGid: '9007199254740993', friendName: '第一名', count: 3, totalCount: 3 }
const friendB = { friendGid: '42', friendName: '历史冠军', count: 1, totalCount: 8 }

test('overview keeps the latest account and period and searches the sorted ranking locally', async (t) => {
  const props = reactive({ accountId: 'old' })
  const { requests, finish, view } = mount(t, 'StealAnalysisPanel.vue', props)
  assert.equal(requests[0].options.params.range, '7d')
  props.accountId = 'current'
  assert.equal(requests[0].options.signal.aborted, true)
  assert.equal(requests[1].options.headers['x-account-id'], 'current')
  const overview = { window, ranking: [friendA, friendB] }
  await finish(1, overview)
  await finish(0, { window, ranking: [] })
  assert.equal(view.overview.value, overview)
  assert.deepEqual(view.ranking.value.map(row => row.friendGid), [friendA.friendGid, friendB.friendGid])

  view.page.value = 2
  view.search.value = '冠军'
  await nextTick()
  assert.equal(view.page.value, 1)
  assert.equal(view.ranking.value[0].rank, 2)
  view.sortBy.value = 'totalCount'
  assert.equal(view.ranking.value[0].rank, 1)
  assert.equal(requests.length, 2)

  view.selectedFriend.value = friendA
  view.selectPeriod('custom')
  assert.equal(view.fromDate.value, window.fromDate)
  view.fromDate.value = '2026-11-20'
  view.applyDates()
  assert.equal(requests.length, 2)
  view.fromDate.value = '2026-11-17'
  view.applyDates()
  assert.equal(view.selectedFriend.value, null)
  assert.deepEqual(requests[2].options.params, { range: 'custom', fromDate: '2026-11-17', toDate: '2026-11-19' })
  view.selectPeriod('all')
  assert.equal(requests[2].options.signal.aborted, true)
  await finish(3, overview)
  await finish(2, { window, ranking: [] })
  assert.equal(view.overview.value, overview)
})

test('friend history preserves the exact GID and drops pages from previous filters', async (t) => {
  const { fromDate, toDate, timeZone } = window
  const friendGid = friendA.friendGid
  const { requests, finish, view, scope } = mount(t, 'FriendStealAnalysisPanel.vue', { accountId: 'current', friendGid, fromDate, toDate, timeZone })
  assert.equal(requests[0].url, `/api/analytics/steal-analysis/friends/${friendGid}`)
  assert.deepEqual(requests[1].options.params, { friendGid, fromDate, toDate, triggerType: undefined, cursor: undefined })
  await finish(1, { items: [{ eventId: 'first' }], nextCursor: 'next' })
  void view.loadHistory(view.nextCursor.value)
  assert.equal(requests[2].options.params.cursor, 'next')
  view.trigger.value = 'manual'
  assert.equal(requests[2].options.signal.aborted, true)
  assert.deepEqual(requests[3].options.params, { friendGid, fromDate, toDate, triggerType: 'manual', cursor: undefined })
  await finish(3, { items: [{ eventId: 'manual' }], nextCursor: null })
  await finish(2, { items: [{ eventId: 'stale' }], nextCursor: null })
  assert.deepEqual(view.items.value, [{ eventId: 'manual' }])
  scope.stop()
  assert.equal(requests[0].options.signal.aborted, true)
})
