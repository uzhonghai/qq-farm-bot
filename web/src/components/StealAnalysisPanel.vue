<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui/es/data-table'
import type { FriendStealRanking, StealAnalysisOverview, StealAnalysisPeriod } from '@/types/steal-analysis'
import { NButton } from 'naive-ui/es/button'
import { NCard } from 'naive-ui/es/card'
import { NDataTable } from 'naive-ui/es/data-table'
import { NDatePicker } from 'naive-ui/es/date-picker'
import { NInput } from 'naive-ui/es/input'
import { NModal } from 'naive-ui/es/modal'
import { NSelect } from 'naive-ui/es/select'
import { computed, h, onScopeDispose, ref, shallowRef, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import FriendStealAnalysisPanel from './FriendStealAnalysisPanel.vue'
import StealHeatmap from './StealHeatmap.vue'

const props = defineProps<{ accountId: string }>()

const periods: { label: string, value: StealAnalysisPeriod }[] = [
  { label: '今日', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '全部历史', value: 'all' },
  { label: '自定义', value: 'custom' },
]
type Preset = Exclude<StealAnalysisPeriod, 'custom'>
type Range = { range: Preset } | { range: 'custom', fromDate: string, toDate: string }
const appliedRange = ref<Range>({ range: '7d' })
const customOpen = ref(false)
const fromDate = ref<string | null>(null)
const toDate = ref<string | null>(null)
const dateRangeInvalid = computed(() => !!fromDate.value && !!toDate.value && fromDate.value > toDate.value)

const overview = shallowRef<StealAnalysisOverview | null>(null)
const selectedFriend = shallowRef<FriendStealRanking | null>(null)
const loading = ref(false)
const errorMessage = ref('')
let pending: AbortController | undefined

type SortKey = 'count' | 'totalCount' | 'autoCount' | 'manualCount' | 'lastOccurredAtMs'
type RankingRow = FriendStealRanking & { rank: number }
const search = ref('')
const sortBy = ref<SortKey>('count')
const sortOptions: { label: string, value: SortKey }[] = [
  { label: '期间次数', value: 'count' },
  { label: '历史累计', value: 'totalCount' },
  { label: '自动次数', value: 'autoCount' },
  { label: '手动次数', value: 'manualCount' },
  { label: '最近操作', value: 'lastOccurredAtMs' },
]
const page = ref(1)
const pagination = computed(() => ({ page: page.value, pageSize: 10, simple: true }))
const ranking = computed(() => {
  const key = sortBy.value
  const keyword = search.value.trim().toLowerCase()
  const rows = [...(overview.value?.ranking ?? [])]
    .sort((a, b) => b[key] - a[key])
    .map((row, index) => ({ ...row, rank: index + 1 }))
  return keyword
    ? rows.filter(row => row.friendGid.includes(keyword) || row.friendName?.toLowerCase().includes(keyword))
    : rows
})

const timeFormatter = computed(() => new Intl.DateTimeFormat('zh-CN', {
  timeZone: overview.value?.window.timeZone,
  dateStyle: 'short',
  timeStyle: 'medium',
  hourCycle: 'h23',
}))
const metrics = computed(() => {
  const coverage = overview.value?.coverage
  if (!coverage)
    return []
  return [
    { label: '偷菜总次数', value: coverage.count.toLocaleString('zh-CN'), unit: '次' },
    { label: '有记录的好友', value: coverage.friendCount.toLocaleString('zh-CN'), unit: '人' },
    { label: '日均次数', value: coverage.averageDailyCount.toLocaleString('zh-CN', { maximumFractionDigits: 1 }), unit: '次' },
    { label: '前 5 名次数占比', value: coverage.topFiveShare.toLocaleString('zh-CN', { style: 'percent', maximumFractionDigits: 1 }) },
  ]
})

const columns: DataTableColumns<RankingRow> = [
  { title: '排名', key: 'rank', width: 64, align: 'right', className: 'tabular-nums' },
  {
    title: '好友',
    key: 'friendName',
    minWidth: 164,
    render: row => h('button', {
      'type': 'button',
      'class': 'max-w-full truncate rounded text-left font-medium text-emerald-700 underline-offset-4 hover:underline focus-visible:outline-2 dark:text-emerald-300',
      'title': row.friendName ?? row.friendGid,
      'aria-label': `查看好友 ${row.friendName ?? row.friendGid} 的偷菜详情`,
      'onClick': () => { selectedFriend.value = row },
    }, row.friendName ?? row.friendGid),
  },
  { title: 'GID', key: 'friendGid', width: 180, className: 'tabular-nums' },
  { title: '期间次数', key: 'count', width: 100, align: 'right', className: 'font-semibold tabular-nums' },
  { title: '历史累计', key: 'totalCount', width: 100, align: 'right', className: 'tabular-nums' },
  { title: '自动', key: 'autoCount', width: 76, align: 'right', className: 'tabular-nums' },
  { title: '手动', key: 'manualCount', width: 76, align: 'right', className: 'tabular-nums' },
  {
    title: '最近一次',
    key: 'lastOccurredAtMs',
    width: 165,
    className: 'tabular-nums',
    render: row => h('time', { datetime: new Date(row.lastOccurredAtMs).toISOString() }, timeFormatter.value.format(row.lastOccurredAtMs)),
  },
]

async function load() {
  pending?.abort()
  selectedFriend.value = null
  overview.value = null
  errorMessage.value = ''
  page.value = 1
  if (!props.accountId) {
    pending = undefined
    loading.value = false
    return
  }

  const request = new AbortController()
  pending = request
  loading.value = true
  try {
    const { data } = await api.get<{ ok: boolean, data: StealAnalysisOverview }>('/api/analytics/steal-analysis', {
      headers: { 'x-account-id': props.accountId },
      params: appliedRange.value,
      signal: request.signal,
    })
    if (!request.signal.aborted)
      overview.value = data.data
  }
  catch (error) {
    if (!request.signal.aborted)
      errorMessage.value = getApiErrorMessage(error, '暂时无法读取偷菜分析，请重试')
  }
  finally {
    if (!request.signal.aborted) {
      pending = undefined
      loading.value = false
    }
  }
}

function selectPeriod(period: StealAnalysisPeriod) {
  if (period === 'custom') {
    if (!customOpen.value && overview.value) {
      fromDate.value = overview.value.window.fromDate
      toDate.value = overview.value.window.toDate
    }
    customOpen.value = !customOpen.value
    return
  }
  customOpen.value = false
  if (appliedRange.value.range !== period) {
    appliedRange.value = { range: period }
    void load()
  }
}

function applyDates() {
  if (!fromDate.value || !toDate.value || dateRangeInvalid.value)
    return
  appliedRange.value = { range: 'custom', fromDate: fromDate.value, toDate: toDate.value }
  void load()
}

watch([search, sortBy], () => {
  page.value = 1
})
watch(() => props.accountId, () => {
  search.value = ''
  void load()
}, { immediate: true, flush: 'sync' })
onScopeDispose(() => pending?.abort())
</script>

<template>
  <section class="space-y-4" aria-label="好友偷菜分析" :aria-busy="loading">
    <div v-if="!accountId" class="border farm-card border-gray-200 rounded-2xl bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">
      请选择游戏账号
    </div>
    <template v-else>
      <div class="border farm-card border-gray-200 rounded-2xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="统计日期范围" class="flex flex-wrap gap-2">
            <NButton
              v-for="period in periods"
              :key="period.value"
              size="small"
              :type="appliedRange.range === period.value ? 'primary' : 'default'"
              :aria-pressed="appliedRange.range === period.value"
              :aria-expanded="period.value === 'custom' ? customOpen : undefined"
              secondary
              @click="selectPeriod(period.value)"
            >
              {{ period.label }}
            </NButton>
          </div>
          <NButton size="small" :loading="loading" @click="load">
            刷新
          </NButton>
        </div>
        <form v-if="customOpen" class="mt-3 flex flex-wrap items-end gap-2" aria-label="自定义统计日期" @submit.prevent="applyDates">
          <label class="min-w-36 flex-1 sm:max-w-42">
            <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">开始日期</span>
            <NDatePicker v-model:formatted-value="fromDate" type="date" value-format="yyyy-MM-dd" size="small" clearable />
          </label>
          <label class="min-w-36 flex-1 sm:max-w-42">
            <span class="mb-1 block text-xs text-gray-500 dark:text-gray-400">结束日期</span>
            <NDatePicker v-model:formatted-value="toDate" type="date" value-format="yyyy-MM-dd" size="small" clearable />
          </label>
          <NButton size="small" attr-type="submit" type="primary" :disabled="!fromDate || !toDate || dateRangeInvalid">
            应用
          </NButton>
          <p v-if="dateRangeInvalid" role="alert" class="w-full text-sm text-red-700 dark:text-red-300">
            结束日期须在开始日期当天或之后
          </p>
        </form>
        <p v-if="overview" class="mt-3 text-xs text-gray-500 dark:text-gray-400">
          <template v-if="overview.window.fromDate">
            {{ overview.window.fromDate }} 至 {{ overview.window.toDate }} · {{ overview.window.dayCount }} 天 ·
          </template>
          {{ overview.window.timeZone }}
        </p>
      </div>

      <div v-if="errorMessage" class="flex flex-wrap items-center gap-3 p-4" role="alert">
        <span>{{ errorMessage }}</span>
        <NButton size="small" @click="load">
          重试
        </NButton>
      </div>
      <p v-else-if="loading" role="status" class="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
        正在加载偷菜分析…
      </p>
      <template v-else-if="overview">
        <dl class="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="偷菜覆盖">
          <div v-for="metric in metrics" :key="metric.label" class="border farm-card border-gray-200 rounded-2xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <dt class="text-sm text-gray-500 dark:text-gray-400">
              {{ metric.label }}
            </dt>
            <dd class="mt-1 text-2xl tabular-nums font-semibold">
              {{ metric.value }} <span v-if="metric.unit" class="text-sm text-gray-500 font-normal dark:text-gray-400">{{ metric.unit }}</span>
            </dd>
          </div>
        </dl>

        <section aria-label="好友次数排行" class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white dark:border-gray-700 dark:bg-gray-800">
          <div class="flex flex-wrap items-center justify-between gap-3 p-4">
            <h2 class="text-base font-semibold">
              好友次数排行
            </h2>
            <div class="w-full flex gap-2 sm:w-auto">
              <div class="min-w-0 flex-1 sm:w-48 sm:flex-none">
                <NInput v-model:value="search" size="small" aria-label="按昵称或 GID 搜索" placeholder="搜索昵称或 GID" clearable />
              </div>
              <div class="w-32 shrink-0">
                <NSelect v-model:value="sortBy" size="small" aria-label="排行排序" :options="sortOptions" />
              </div>
            </div>
          </div>
          <NDataTable
            :columns="columns"
            :data="ranking"
            :row-key="row => row.friendGid"
            :pagination="pagination"
            :scroll-x="925"
            :bordered="false"
            size="small"
            @update:page="page = $event"
          >
            <template #empty>
              {{ overview.ranking.length ? '没有匹配的好友' : '所选期间暂无偷菜记录' }}
            </template>
          </NDataTable>
        </section>

        <section aria-label="时段分布" class="border farm-card border-gray-200 rounded-2xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 class="mb-3 text-base font-semibold">
            时段分布
          </h2>
          <StealHeatmap :counts="overview.heatmap" />
        </section>
      </template>
    </template>

    <NModal :show="!!selectedFriend" @update:show="show => { if (!show) selectedFriend = null }">
      <NCard
        v-if="selectedFriend && overview?.window.fromDate"
        class="friend-detail-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`${selectedFriend.friendName ?? selectedFriend.friendGid} 的偷菜详情`"
        :title="selectedFriend.friendName ?? '好友详情'"
        closable
        @close="selectedFriend = null"
      >
        <FriendStealAnalysisPanel
          :key="selectedFriend.friendGid"
          :account-id="accountId"
          :friend-gid="selectedFriend.friendGid"
          :from-date="overview.window.fromDate"
          :to-date="overview.window.toDate"
          :time-zone="overview.window.timeZone"
        />
      </NCard>
    </NModal>
  </section>
</template>

<style scoped>
.friend-detail-modal {
  width: min(960px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  overflow-y: auto;
}
</style>
