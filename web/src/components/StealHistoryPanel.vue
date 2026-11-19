<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui/es/data-table'
import { NButton } from 'naive-ui/es/button'
import { NDataTable } from 'naive-ui/es/data-table'
import { NDatePicker } from 'naive-ui/es/date-picker'
import { NInput } from 'naive-ui/es/input'
import { NSelect } from 'naive-ui/es/select'
import { computed, h, onScopeDispose, ref, watch } from 'vue'
import api from '@/api'

type StealTrigger = 'auto' | 'manual'

interface StealHistoryEntry {
  eventId: string
  friendGid: string
  friendName: string | null
  occurredAtMs: number
  triggerType: StealTrigger
  friendTodayCount?: number
  friendTotalCount?: number
  friendSkippedCount?: number
}

interface HistoryPage {
  items: StealHistoryEntry[]
  nextCursor: string | null
  todayCount?: number
  totalCount?: number
  timeZone?: string
}

interface HistoryFilters {
  friend?: string
  triggerType?: StealTrigger
  fromDate?: string
  toDate?: string
}

const props = defineProps<{ accountId: string }>()
const friendSearch = ref('')
const triggerFilter = ref<StealTrigger | null>(null)
const fromDate = ref<string | null>(null)
const toDate = ref<string | null>(null)
const appliedFilters = ref<HistoryFilters>({})
const triggerOptions = [
  { label: '手动', value: 'manual' },
  { label: '自动', value: 'auto' },
]
const dateRangeInvalid = computed(() => !!fromDate.value && !!toDate.value && fromDate.value > toDate.value)
const hasFilters = computed(() => Object.values(appliedFilters.value).some(Boolean))
const items = ref<StealHistoryEntry[]>([])
const nextCursor = ref<string | null>(null)
const summary = ref<Pick<HistoryPage, 'todayCount' | 'totalCount' | 'timeZone'> | null>(null)
const loading = ref(false)
const failed = ref(false)
let pending: AbortController | undefined

const timeFormatter = computed(() => new Intl.DateTimeFormat('zh-CN', {
  timeZone: summary.value?.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}))

function formatCount(count?: number) {
  return count?.toLocaleString('zh-CN') ?? '—'
}

const columns: DataTableColumns<StealHistoryEntry> = [
  { title: '好友 GID', key: 'friendGid', width: 180, className: 'tabular-nums' },
  {
    title: '好友名称',
    key: 'friendName',
    ellipsis: true,
    cellProps: row => ({ title: row.friendName ?? undefined }),
    render: row => row.friendName || '—',
  },
  {
    title: '触发方式',
    key: 'triggerType',
    width: 84,
    render: row => row.triggerType === 'auto' ? '自动' : '手动',
  },
  {
    title: '今日次数',
    key: 'friendTodayCount',
    width: 96,
    align: 'right',
    className: 'tabular-nums',
    render: row => formatCount(row.friendTodayCount),
  },
  {
    title: '总计次数',
    key: 'friendTotalCount',
    width: 96,
    align: 'right',
    className: 'tabular-nums',
    render: row => formatCount(row.friendTotalCount),
  },
  {
    title: () => h('span', { title: '该好友在当前偷菜间隔内已跳过的作物轮数' }, '跳过偷菜次数'),
    key: 'friendSkippedCount',
    width: 120,
    align: 'right',
    className: 'tabular-nums',
    render: row => formatCount(row.friendSkippedCount),
  },
  {
    title: '操作时间',
    key: 'occurredAtMs',
    width: 180,
    className: 'tabular-nums',
    render: ({ occurredAtMs }) => h('time', { datetime: new Date(occurredAtMs).toISOString() }, timeFormatter.value.format(occurredAtMs)),
  },
]

async function load(cursor: string | null = null) {
  const accountId = props.accountId
  if (!accountId)
    return

  pending?.abort()
  const request = new AbortController()
  pending = request
  loading.value = true
  failed.value = false
  const isCurrent = () => pending === request && props.accountId === accountId

  try {
    const { data } = await api.get<{ ok: boolean, data: HistoryPage }>('/api/analytics/steal-history', {
      headers: { 'x-account-id': accountId },
      params: { ...appliedFilters.value, cursor: cursor ?? undefined },
      signal: request.signal,
    })
    if (!isCurrent())
      return
    const { items: pageItems, nextCursor: cursorAfterPage, todayCount, totalCount, timeZone } = data.data
    if (cursor) {
      const countsByFriend = new Map(pageItems.map(({ friendGid, friendTodayCount, friendTotalCount, friendSkippedCount }) =>
        [friendGid, { friendTodayCount, friendTotalCount, friendSkippedCount }],
      ))
      items.value = [...items.value.map(item => ({ ...item, ...countsByFriend.get(item.friendGid) })), ...pageItems]
    }
    else {
      items.value = pageItems
    }
    nextCursor.value = cursorAfterPage
    summary.value = { todayCount, totalCount, timeZone }
  }
  catch {
    if (isCurrent())
      failed.value = true
  }
  finally {
    if (isCurrent()) {
      pending = undefined
      loading.value = false
    }
  }
}

function applyFilters() {
  if (dateRangeInvalid.value)
    return
  appliedFilters.value = {
    friend: friendSearch.value.trim() || undefined,
    triggerType: triggerFilter.value ?? undefined,
    fromDate: fromDate.value ?? undefined,
    toDate: toDate.value ?? undefined,
  }
  items.value = []
  nextCursor.value = null
  void load()
}

function resetFilters() {
  friendSearch.value = ''
  triggerFilter.value = null
  fromDate.value = null
  toDate.value = null
  applyFilters()
}

watch(() => props.accountId, () => {
  pending?.abort()
  pending = undefined
  items.value = []
  nextCursor.value = null
  summary.value = null
  failed.value = false
  loading.value = false
  void load()
}, { immediate: true })

onScopeDispose(() => {
  pending?.abort()
  pending = undefined
})
</script>

<template>
  <section aria-label="偷菜记录" class="overflow-hidden border farm-card border-gray-200 rounded-2xl bg-white dark:border-gray-700 dark:bg-gray-800">
    <div class="flex items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
      <dl class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div v-if="typeof summary?.todayCount === 'number'" class="flex flex-wrap items-baseline gap-x-2">
          <dt class="text-gray-500 dark:text-gray-400">
            账号今日次数
          </dt>
          <dd class="tabular-nums font-semibold">
            {{ summary.todayCount.toLocaleString('zh-CN') }} 次
          </dd>
        </div>
        <div v-if="typeof summary?.totalCount === 'number'" class="flex flex-wrap items-baseline gap-x-2">
          <dt class="text-gray-500 dark:text-gray-400">
            账号总计次数
          </dt>
          <dd class="tabular-nums font-semibold">
            {{ summary.totalCount.toLocaleString('zh-CN') }} 次
          </dd>
        </div>
      </dl>
      <NButton class="ml-auto" size="small" :disabled="!accountId || loading" @click="load()">
        刷新
      </NButton>
    </div>

    <form v-if="accountId" aria-label="筛选偷菜记录" class="border-b border-gray-200 px-4 py-3 dark:border-gray-700" @submit.prevent="applyFilters">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block w-full text-sm sm:w-52">
          <span class="mb-1 block text-gray-600 dark:text-gray-300">好友</span>
          <NInput v-model:value="friendSearch" clearable size="small" :maxlength="100" placeholder="输入好友名称或 GID" />
        </label>
        <div role="group" aria-labelledby="steal-history-trigger" class="w-full text-sm sm:w-32">
          <span id="steal-history-trigger" class="mb-1 block text-gray-600 dark:text-gray-300">触发方式</span>
          <NSelect v-model:value="triggerFilter" :options="triggerOptions" clearable size="small" placeholder="全部方式" />
        </div>
        <div class="grid grid-cols-2 w-full gap-3 text-sm sm:w-auto">
          <label class="block min-w-0 sm:w-36">
            <span class="mb-1 block text-gray-600 dark:text-gray-300">开始日期</span>
            <NDatePicker v-model:formatted-value="fromDate" type="date" value-format="yyyy-MM-dd" clearable size="small" placeholder="不限" />
          </label>
          <label class="block min-w-0 sm:w-36">
            <span class="mb-1 block text-gray-600 dark:text-gray-300">结束日期</span>
            <NDatePicker v-model:formatted-value="toDate" type="date" value-format="yyyy-MM-dd" clearable size="small" placeholder="不限" />
          </label>
        </div>
        <div class="flex gap-2">
          <NButton size="small" attr-type="submit" type="primary" :disabled="dateRangeInvalid">
            筛选
          </NButton>
          <NButton size="small" @click="resetFilters">
            重置
          </NButton>
        </div>
      </div>
      <p v-if="dateRangeInvalid" role="alert" class="mt-2 text-sm text-red-700 dark:text-red-300">
        结束日期须在开始日期当天或之后
      </p>
    </form>

    <p v-if="!accountId" class="px-4 py-8 text-center text-sm text-gray-500">
      请选择游戏账号
    </p>
    <p v-if="failed" role="alert" class="px-4 py-4 text-center text-sm text-red-700 dark:text-red-300">
      暂时无法读取偷菜记录，请重试
    </p>

    <NDataTable
      v-if="accountId && (!failed || items.length)"
      role="region"
      aria-label="偷菜记录表格，次数按该行好友统计"
      :aria-busy="loading"
      size="small"
      :columns="columns"
      :data="items"
      :row-key="(item: StealHistoryEntry) => item.eventId"
      :loading="loading"
      :bordered="false"
      :bottom-bordered="false"
      :scroll-x="900"
    >
      <template #empty>
        {{ hasFilters ? '没有符合条件的偷菜记录' : '暂无偷菜记录' }}
      </template>
    </NDataTable>

    <div v-if="nextCursor" class="flex justify-center border-t border-gray-100 px-4 py-3 dark:border-gray-700">
      <NButton size="small" :loading="loading" @click="load(nextCursor)">
        加载更多
      </NButton>
    </div>
  </section>
</template>
