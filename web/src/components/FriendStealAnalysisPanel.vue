<script setup lang="ts">
import type { FriendStealAnalysis, FriendStealHistoryPage, StealTrigger } from '@/types/steal-analysis'
import { NButton } from 'naive-ui/es/button'
import { NSelect } from 'naive-ui/es/select'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import StealHeatmap from './StealHeatmap.vue'

const props = defineProps<{
  accountId: string
  friendGid: string
  fromDate: string
  toDate: string
  timeZone: string
}>()

const detail = shallowRef<FriendStealAnalysis | null>(null)
const detailError = ref('')
const items = shallowRef<FriendStealHistoryPage['items']>([])
const nextCursor = ref<string | null>(null)
const loadingHistory = ref(false)
const historyError = ref('')
const trigger = ref<StealTrigger | null>(null)
const triggerOptions = [{ label: '自动', value: 'auto' }, { label: '手动', value: 'manual' }]
const timeFormatter = computed(() => new Intl.DateTimeFormat('zh-CN', {
  timeZone: detail.value?.window.timeZone ?? props.timeZone,
  dateStyle: 'short',
  timeStyle: 'medium',
  hourCycle: 'h23',
}))
const stats = computed(() => detail.value && [
  { label: '期间次数', value: detail.value.friend.count.toLocaleString('zh-CN') },
  { label: '期间活跃天数', value: detail.value.activeDays.toLocaleString('zh-CN') },
  { label: '历史累计', value: detail.value.friend.totalCount.toLocaleString('zh-CN') },
  { label: '近 7 天', value: detail.value.last7DaysCount.toLocaleString('zh-CN') },
  { label: '近 30 天', value: detail.value.last30DaysCount.toLocaleString('zh-CN') },
  { label: '最近一次', value: timeFormatter.value.format(detail.value.friend.lastOccurredAtMs) },
])

const detailRequest = new AbortController()
let historyRequest: AbortController | undefined

async function loadDetail() {
  detailError.value = ''
  try {
    const { data } = await api.get<{ ok: boolean, data: FriendStealAnalysis }>(`/api/analytics/steal-analysis/friends/${encodeURIComponent(props.friendGid)}`, {
      headers: { 'x-account-id': props.accountId },
      params: { range: 'custom', fromDate: props.fromDate, toDate: props.toDate },
      signal: detailRequest.signal,
    })
    if (!detailRequest.signal.aborted)
      detail.value = data.data
  }
  catch (error) {
    if (!detailRequest.signal.aborted)
      detailError.value = getApiErrorMessage(error, '暂时无法读取好友统计，请重试')
  }
}

async function loadHistory(cursor: string | null = null) {
  historyRequest?.abort()
  const request = new AbortController()
  historyRequest = request
  loadingHistory.value = true
  historyError.value = ''
  if (!cursor) {
    items.value = []
    nextCursor.value = null
  }

  try {
    const { data } = await api.get<{ ok: boolean, data: FriendStealHistoryPage }>('/api/analytics/steal-history', {
      headers: { 'x-account-id': props.accountId },
      params: {
        friendGid: props.friendGid,
        fromDate: props.fromDate,
        toDate: props.toDate,
        triggerType: trigger.value ?? undefined,
        cursor: cursor ?? undefined,
      },
      signal: request.signal,
    })
    if (request.signal.aborted)
      return
    const page = data.data
    items.value = cursor ? [...items.value, ...page.items] : page.items
    nextCursor.value = page.nextCursor
  }
  catch (error) {
    if (!request.signal.aborted)
      historyError.value = getApiErrorMessage(error, '暂时无法读取操作明细，请重试')
  }
  finally {
    if (!request.signal.aborted) {
      historyRequest = undefined
      loadingHistory.value = false
    }
  }
}

onScopeDispose(() => {
  detailRequest.abort()
  historyRequest?.abort()
})

void loadDetail()
watch(trigger, () => void loadHistory(), { immediate: true, flush: 'sync' })
</script>

<template>
  <div class="space-y-5">
    <p class="flex flex-wrap gap-x-3 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
      <span>GID {{ friendGid }}</span>
      <span>{{ fromDate }} 至 {{ toDate }}</span>
    </p>
    <div v-if="detailError" class="flex flex-wrap items-center gap-3" role="alert">
      <span>{{ detailError }}</span>
      <NButton size="small" @click="loadDetail">
        重试
      </NButton>
    </div>
    <p v-else-if="!detail" role="status" class="text-sm text-gray-500">
      正在加载好友统计…
    </p>
    <template v-else>
      <dl class="grid grid-cols-2 gap-x-3 gap-y-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-3 dark:bg-gray-800/70">
        <div v-for="stat in stats" :key="stat.label">
          <dt class="text-xs text-gray-500 dark:text-gray-400">
            {{ stat.label }}
          </dt>
          <dd class="mt-1 text-base tabular-nums font-semibold">
            {{ stat.value }}
          </dd>
        </div>
      </dl>
      <section aria-label="好友时段分布">
        <h3 class="mb-2 text-base font-semibold">
          时段分布
        </h3>
        <StealHeatmap :counts="detail.heatmap" />
      </section>
    </template>

    <section aria-label="好友偷菜明细" :aria-busy="loadingHistory">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base font-semibold">
          偷菜明细
        </h3>
        <NSelect v-model:value="trigger" :options="triggerOptions" aria-label="筛选触发方式" clearable size="small" placeholder="全部方式" class="w-32" />
      </div>
      <table v-if="items.length" class="w-full border-collapse text-left text-sm tabular-nums">
        <thead class="text-gray-500 dark:text-gray-400">
          <tr class="border-b border-gray-200 dark:border-gray-700">
            <th scope="col" class="py-2 font-medium">
              操作时间
            </th>
            <th scope="col" class="py-2 font-medium">
              触发方式
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in items" :key="row.eventId" class="border-b border-gray-200 dark:border-gray-700">
            <td class="py-2">
              <time :datetime="new Date(row.occurredAtMs).toISOString()">{{ timeFormatter.format(row.occurredAtMs) }}</time>
            </td>
            <td class="py-2">
              {{ row.triggerType === 'auto' ? '自动' : '手动' }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="historyError" class="mt-3 flex flex-wrap items-center gap-3" role="alert">
        <span>{{ historyError }}</span>
        <NButton size="small" @click="loadHistory(nextCursor)">
          重试
        </NButton>
      </div>
      <p v-else-if="loadingHistory && !items.length" role="status" class="py-3 text-sm text-gray-500">
        正在加载偷菜明细…
      </p>
      <p v-else-if="!items.length" class="py-3 text-sm text-gray-500 dark:text-gray-400">
        没有符合条件的偷菜记录
      </p>
      <NButton v-else-if="nextCursor" size="small" class="mt-3" :loading="loadingHistory" @click="loadHistory(nextCursor)">
        加载更多
      </NButton>
    </section>
  </div>
</template>
