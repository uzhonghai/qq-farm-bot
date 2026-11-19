<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ counts: number[][] }>()
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
const rows = computed(() => {
  const maximum = Math.max(1, ...props.counts.flat())
  return weekdays.map((weekday, day) => ({
    weekday,
    cells: hours.map((hour, index) => {
      const count = props.counts[day]?.[index] ?? 0
      return { hour, count, level: Math.ceil(4 * count / maximum) }
    }),
  }))
})
</script>

<template>
  <div class="overflow-x-auto" tabindex="0" role="region" aria-label="按星期和小时查看偷菜次数">
    <table class="heatmap w-full text-center text-xs tabular-nums" aria-label="时段分布（每格为偷菜次数）">
      <thead>
        <tr class="text-gray-500 dark:text-gray-400">
          <th scope="col" class="heatmap__axis min-w-12 font-medium">
            小时
          </th>
          <th v-for="hour in hours" :key="hour" scope="col" class="min-w-8 pb-1 font-medium">
            {{ hour }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ weekday, cells } in rows" :key="weekday">
          <th scope="row" class="heatmap__axis text-gray-500 font-medium dark:text-gray-400">
            {{ weekday }}
          </th>
          <td
            v-for="{ hour, count, level } in cells"
            :key="hour"
            class="heatmap__cell rounded py-1.5"
            :class="`heatmap__cell--${level}`"
            :title="`${weekday} ${hour}:00 · ${count} 次`"
          >
            {{ count }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.heatmap {
  border-collapse: separate;
  border-spacing: 2px;
}

.heatmap__axis {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--ui-surface-solid, white);
}

.heatmap__cell {
  background: #f3f4f6;
  color: #4b5563;
}

.heatmap__cell--1 {
  background: #d1fae5;
  color: #064e3b;
}
.heatmap__cell--2 {
  background: #a7f3d0;
  color: #064e3b;
}
.heatmap__cell--3 {
  background: #6ee7b7;
  color: #064e3b;
}
.heatmap__cell--4 {
  background: #047857;
  color: white;
}

:global(.dark .heatmap__cell--0) {
  background: #1f2937;
  color: #9ca3af;
}
:global(.dark .heatmap__cell--1) {
  background: #064e3b;
  color: #ecfdf5;
}
:global(.dark .heatmap__cell--2) {
  background: #047857;
  color: #ecfdf5;
}
:global(.dark .heatmap__cell--3) {
  background: #34d399;
  color: #022c22;
}
:global(.dark .heatmap__cell--4) {
  background: #a7f3d0;
  color: #022c22;
}
</style>
