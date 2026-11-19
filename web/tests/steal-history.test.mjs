import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { NConfigProvider } = require('naive-ui/lib/config-provider')
const { NDataTable } = require('naive-ui/lib/data-table')
const ts = require('typescript')
const { createSSRApp, effectScope, h, nextTick, reactive } = require('vue')
const { compileScript, compileTemplate, parse } = require('vue/compiler-sfc')
const { renderToString } = require('vue/server-renderer')

test('history table renders friend counts and ignores stale requests when accounts or filters change', async (t) => {
  const requests = []
  const api = {
    get: (url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve })
    }),
  }
  const source = readFileSync(new URL('../src/components/StealHistoryPanel.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const id = 'steal-history-test'
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ id, filename: 'StealHistoryPanel.vue', source: descriptor.template.content })
  assert.deepEqual(template.errors, [])
  const { outputText } = ts.transpileModule(`${script.content}\n${template.code}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  const inputStub = { render: () => h('input') }
  const imports = {
    '@/api': api,
    'naive-ui/es/button': { NButton: {} },
    'naive-ui/es/data-table': { NDataTable },
    'naive-ui/es/date-picker': { NDatePicker: inputStub },
    'naive-ui/es/input': { NInput: inputStub },
    'naive-ui/es/select': { NSelect: inputStub },
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(
    id => imports[id] || require(id),
    module,
    module.exports,
  )
  const scope = effectScope()
  t.after(() => scope.stop())
  const props = reactive({ accountId: 'a' })
  const panel = scope.run(() => module.exports.default.setup(props, { expose() {} }))
  const finish = (index, item, summary, nextCursor = null) => requests[index].resolve({
    data: { ok: true, data: { items: [item], nextCursor, ...summary } },
  })
  const friend = { friendGid: '42', friendName: '好友', occurredAtMs: 1795100000000, triggerType: 'auto' }
  const summaryB = { todayCount: 8, totalCount: 35, timeZone: 'Asia/Shanghai' }
  const summaryA = { todayCount: 0, totalCount: 7, timeZone: 'America/New_York' }
  const countsB = { friendTodayCount: 4, friendTotalCount: 10, friendSkippedCount: 1 }
  const countsA = { friendTodayCount: 0, friendTotalCount: 3, friendSkippedCount: 2 }

  props.accountId = 'b'
  await nextTick()
  assert.equal(requests[0].options.signal.aborted, true)
  finish(1, { ...friend, ...countsB, eventId: 'b-result' }, summaryB, 'b-next')
  await nextTick()
  assert.deepEqual(panel.items.value.map(item => item.eventId), ['b-result'])
  assert.deepEqual(panel.summary.value, summaryB)
  void panel.load(panel.nextCursor.value)
  assert.equal(requests[2].options.params.cursor, 'b-next')
  const updatedCounts = { friendTodayCount: 5, friendTotalCount: 11, friendSkippedCount: 0 }
  finish(2, { ...friend, ...updatedCounts, eventId: 'b-page-2' }, summaryB, 'b-page-3')
  await nextTick()
  assert.deepEqual(panel.items.value, [
    { ...friend, ...updatedCounts, eventId: 'b-result' },
    { ...friend, ...updatedCounts, eventId: 'b-page-2' },
  ])
  assert.deepEqual(panel.summary.value, summaryB)

  void panel.load(panel.nextCursor.value)
  props.accountId = 'a'
  await nextTick()
  assert.deepEqual(panel.items.value, [])
  assert.equal(panel.summary.value, null)
  assert.equal(requests[3].options.signal.aborted, true)
  finish(4, { ...friend, ...countsA, eventId: 'fresh-a' }, summaryA)
  await nextTick()
  finish(0, { ...friend, ...countsB, eventId: 'stale-a' }, { ...summaryA, todayCount: 20, totalCount: 99 })
  finish(3, { ...friend, ...countsB, eventId: 'stale-b-page' }, { ...summaryB, todayCount: 13, totalCount: 40 })
  await nextTick()
  assert.deepEqual(panel.items.value, [{ ...friend, ...countsA, eventId: 'fresh-a' }])
  assert.deepEqual(panel.summary.value, summaryA)
  assert.equal(panel.timeFormatter.value.resolvedOptions().timeZone, summaryA.timeZone)
  assert.equal(panel.loading.value, false)

  const view = { render: module.exports.render, setup: () => ({ ...panel, accountId: props.accountId }) }
  const app = createSSRApp({ render: () => h(NConfigProvider, null, { default: () => h(view) }) })
  app.component('NButton', { render: () => h('button') })
  app.component('NDataTable', NDataTable)
  app.component('NDatePicker', inputStub)
  app.component('NInput', inputStub)
  app.component('NSelect', inputStub)
  const html = await renderToString(app)
  assert.match(html, /<form[^>]*aria-label="筛选偷菜记录"[^>]*>.*?开始日期.*?结束日期.*?<\/form>.*?<table/s)
  assert.match(html, /<table[^>]*class="n-data-table-table"/)
  const headings = Array.from(html.matchAll(/<th\b[^>]*>(.*?)<\/th>/gs), ([, content]) => content.replace(/<[^>]*>/g, '').trim())
  assert.deepEqual(headings, ['好友 GID', '好友名称', '触发方式', '今日次数', '总计次数', '跳过偷菜次数', '操作时间'])
  const cells = Array.from(html.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs), ([, content]) => content.replace(/<[^>]*>/g, '').trim())
  assert.equal(cells.length, headings.length)
  assert.deepEqual(cells.slice(3, -1), ['0', '3', '2'])

  void panel.load()
  finish(5, { ...friend, eventId: 'older-backend' }, { totalCount: 12 })
  await nextTick()
  assert.deepEqual(panel.items.value.map(item => item.eventId), ['older-backend'])
  assert.equal(panel.summary.value.totalCount, 12)
  assert.equal(panel.summary.value.todayCount, undefined)

  panel.friendSearch.value = ' 42 '
  panel.triggerFilter.value = 'manual'
  panel.fromDate.value = '2026-11-19'
  panel.toDate.value = '2026-11-18'
  panel.applyFilters()
  assert.equal(panel.dateRangeInvalid.value, true)
  assert.equal(requests.length, 6)

  panel.toDate.value = '2026-11-20'
  panel.applyFilters()
  const filters = { friend: '42', triggerType: 'manual', fromDate: '2026-11-19', toDate: '2026-11-20' }
  assert.deepEqual(requests[6].options.params, { ...filters, cursor: undefined })
  assert.deepEqual(panel.items.value, [])
  assert.equal(panel.nextCursor.value, null)
  finish(6, { ...friend, eventId: 'filtered-a', triggerType: 'manual' }, summaryA, 'filtered-next')
  await nextTick()

  panel.friendSearch.value = '尚未提交的好友'
  void panel.load(panel.nextCursor.value)
  assert.deepEqual(requests[7].options.params, { ...filters, cursor: 'filtered-next' })
  panel.resetFilters()
  assert.equal(requests[7].options.signal.aborted, true)
  assert.deepEqual(requests[8].options.params, {
    friend: undefined,
    triggerType: undefined,
    fromDate: undefined,
    toDate: undefined,
    cursor: undefined,
  })
  finish(8, { ...friend, eventId: 'reset-a' }, summaryA)
  finish(7, { ...friend, eventId: 'stale-filtered-a' }, summaryA)
  await nextTick()
  assert.deepEqual(panel.items.value.map(item => item.eventId), ['reset-a'])
})
