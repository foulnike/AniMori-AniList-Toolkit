<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { isAniListRateLimited } from '../../api/anilist'
import { getAnime365FailStreak, isAnime365Disabled } from '../../api/anime365'
import { isShikimoriRateLimited } from '../../api/shikimori'
import { ANIME365_FAIL_LIMIT } from '../../core/constants'
import { getDbStats } from '../../core/db'
import { settings } from '../../core/settings'
import { escapeHTML } from '../../utils/dom'
import { Logger, scriptLogs } from '../../utils/logger'
import { listMountedApps } from '../../utils/vue-mounter'
import { getPendingQueueSizes } from '../translator'
import {
  FILTERS,
  activeFilter,
  clearLogEntries,
  displayItems,
  isLoggerOpen,
  searchQuery,
  syncLogEntries,
  type DisplayItem,
  type LogGroup,
  type LogSingle,
} from './logger-state'

// ---------- DOM-референции ----------

const containerRef = ref<HTMLElement | null>(null)

// ---------- UI-состояние ----------

const unreadCount = ref(0)
const stateLoading = ref(false)
const copyLabel = ref('Копировать')

// Открытые группы / details / stack — Set<idx|id>.
// Сбрасываем только при смене фильтра или поиска, но не при каждом новом логе.
const openGroups = ref(new Set<number>())
const openDetails = ref(new Set<number>())
const openStacks = ref(new Set<number>())

watch([activeFilter, searchQuery], () => {
  openGroups.value = new Set()
  openDetails.value = new Set()
  openStacks.value = new Set()
})

// ---------- Скролл ----------

function isAtBottom(): boolean {
  const c = containerRef.value
  if (!c) return true
  return c.scrollHeight - c.scrollTop <= c.clientHeight + 30
}

function scrollToBottom(): void {
  const c = containerRef.value
  if (!c) return
  c.scrollTop = c.scrollHeight
  unreadCount.value = 0
}

function onContainerScroll(): void {
  if (isAtBottom()) unreadCount.value = 0
}

// При новых записях: автоскролл или счётчик непрочитанных
watch(displayItems, async () => {
  if (!isLoggerOpen.value) return
  await nextTick()
  if (isAtBottom()) {
    scrollToBottom()
  } else {
    unreadCount.value++
  }
})

// При открытии: синхронизируем логи и прокручиваем вниз
watch(isLoggerOpen, async (val) => {
  if (val) {
    syncLogEntries()
    unreadCount.value = 0
    await nextTick()
    scrollToBottom()
  }
})

onMounted(() => {
  if (isLoggerOpen.value) syncLogEntries()
})

// ---------- Действия ----------

function close(): void {
  isLoggerOpen.value = false
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function setFilter(f: string): void {
  activeFilter.value = f
}

function onSearch(e: Event): void {
  searchQuery.value = (e.target as HTMLInputElement).value.trim()
}

function onClear(): void {
  clearLogEntries()
  Logger('INFO', 'Логгер очищен вручную')
}

async function onDumpState(): Promise<void> {
  stateLoading.value = true
  try {
    const dbStats = await getDbStats()
    Logger('INFO', 'DUMP: Текущее состояние скрипта', {
      url: window.location.href,
      settings,
      queueSizes: getPendingQueueSizes(),
      databaseCache: dbStats,
      mountedApps: listMountedApps(),
      rateLimits: {
        anilist: isAniListRateLimited() ? 'Пауза' : 'OK',
        shikimori: isShikimoriRateLimited() ? 'Пауза' : 'OK',
        anime365: {
          failStreak: `${getAnime365FailStreak()}/${ANIME365_FAIL_LIMIT}`,
          disabled: isAnime365Disabled(),
        },
      },
      translationSources: {
        titlePrimary: settings.titlePrimary,
        titleFallback: settings.titleFallback,
      },
    })
  } finally {
    stateLoading.value = false
    await nextTick()
    scrollToBottom()
  }
}

function onCopy(): void {
  const text = scriptLogs
    .map((l) => {
      const det = l.details ? JSON.stringify(l.details, null, 2) : ''
      return `[${l.time}][${l.type}][PATH: ${l.path}] ${l.message}\n${det}`
    })
    .join('\n\n')
  void navigator.clipboard.writeText(text)
  copyLabel.value = '✔ Скопировано'
  setTimeout(() => {
    copyLabel.value = 'Копировать'
  }, 2000)
}

function onDownload(): void {
  const text = scriptLogs
    .map(
      (l) =>
        `[${l.time}] [${l.type}][PATH: ${l.path}]\nMSG: ${l.message}\n` +
        `DETAILS: ${l.details ? JSON.stringify(l.details, null, 2) : 'null'}\nSTACK:\n${l.stack}\n` +
        '---------------------------------------------------',
    )
    .join('\n\n')
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `animori_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- Тогглы ----------

function toggleGroup(idx: number): void {
  const s = new Set(openGroups.value)
  s.has(idx) ? s.delete(idx) : s.add(idx)
  openGroups.value = s
}

function toggleDetails(id: number): void {
  const s = new Set(openDetails.value)
  s.has(id) ? s.delete(id) : s.add(id)
  openDetails.value = s
}

function toggleStack(id: number): void {
  const s = new Set(openStacks.value)
  s.has(id) ? s.delete(id) : s.add(id)
  openStacks.value = s
}

// ---------- JSON-viewer ----------

/** Возвращает доверенный HTML: все строки и ключи экранируются через escapeHTML. */
function jsonView(obj: unknown, isRoot = true): string {
  if (obj === null) return '<span style="color:#f38ba8">null</span>'
  if (typeof obj === 'undefined') return '<span style="color:#f38ba8">undefined</span>'
  if (typeof obj === 'boolean') return `<span style="color:#cba6f7">${String(obj)}</span>`
  if (typeof obj === 'number') return `<span style="color:#fab387">${String(obj)}</span>`
  if (typeof obj === 'string') return `<span style="color:#a6e3a1">"${escapeHTML(obj)}"</span>`

  const indent = isRoot ? 0 : 15
  const open = isRoot ? 'open' : ''

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    let out = `<details ${open} style="margin-left:${indent}px"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none">Array(${obj.length})[</summary><div style="margin-left:15px;border-left:1px solid rgba(255,255,255,0.1);padding-left:10px">`
    for (let i = 0; i < obj.length; i++) {
      out += `<div style="margin-bottom:2px"><span style="color:#cdd6f4">${i}:</span> ${jsonView(obj[i], false)}</div>`
    }
    return out + '</div><span style="color:#89b4fa">]</span></details>'
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return '{}'
    let out = `<details ${open} style="margin-left:${indent}px"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none">Object {</summary><div style="margin-left:15px;border-left:1px solid rgba(255,255,255,0.1);padding-left:10px">`
    for (const key of keys) {
      out += `<div style="margin-bottom:2px"><span style="color:#cdd6f4">"${escapeHTML(key)}":</span> ${jsonView(record[key], false)}</div>`
    }
    return out + '</div><span style="color:#89b4fa">}</span></details>'
  }

  return escapeHTML(String(obj))
}

function safeJsonView(obj: unknown): string {
  try {
    return jsonView(obj)
  } catch {
    return '<span style="color:#f38ba8">[не удалось отрендерить]</span>'
  }
}

// ---------- Вспомогательные функции для шаблона ----------

function shortPath(path: string): string {
  return path === '/' ? '/' : path.split('/').slice(1, 3).join('/') || '/'
}

function asGroup(item: DisplayItem): LogGroup {
  return item as LogGroup
}

function asSingle(item: DisplayItem): LogSingle {
  return item as LogSingle
}
</script>

<template>
  <div v-if="isLoggerOpen" id="am-logger-overlay" @click="onOverlayClick">
    <div class="am-logger-modal" style="position: relative">
      <!-- Шапка -->
      <div class="am-logger-header">
        <h2>
          AniMori Logger
          <span style="font-size: 12px; opacity: 0.6; font-weight: normal">(Session Memory)</span>
        </h2>
        <input
          type="text"
          placeholder="Поиск по логам..."
          :value="searchQuery"
          style="
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #fff;
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 12px;
            outline: none;
            width: 200px;
            transition: 0.2s;
          "
          @input="onSearch"
        />
        <div class="am-logger-filters">
          <button
            v-for="f in FILTERS"
            :key="f"
            class="am-log-filter"
            :class="{ active: activeFilter === f }"
            @click="setFilter(f)"
          >
            {{ f }}
          </button>
        </div>
        <div class="am-logger-actions">
          <button :disabled="stateLoading" @click="() => void onDumpState()">
            {{ stateLoading ? 'Загрузка...' : 'Состояние' }}
          </button>
          <button @click="onDownload">Скачать</button>
          <button @click="onCopy">{{ copyLabel }}</button>
          <button @click="onClear">Очистить</button>
          <button id="am-log-close" @click="close">✖</button>
        </div>
      </div>

      <!-- Список записей -->
      <div id="am-log-container" ref="containerRef" @scroll="onContainerScroll">
        <template v-for="(item, idx) in displayItems" :key="idx">
          <!-- Группа -->
          <div
            v-if="item.kind === 'group'"
            :class="`am-log-group type-${asGroup(item).type.toLowerCase()}`"
          >
            <div
              class="am-log-header am-log-group-header"
              style="cursor: pointer"
              @click="toggleGroup(idx)"
            >
              <span class="am-log-time">{{ asGroup(item).time }}</span>
              <span class="am-log-badge">{{ asGroup(item).type }}</span>
              <span class="am-log-msg am-log-group-count" style="font-style: italic; color: #8b949e"
                >Сгруппировано ({{ asGroup(item).entries.length }})</span
              >
              <span
                class="am-log-expand"
                :style="openGroups.has(idx) ? 'transform:rotate(180deg)' : ''"
                >▼</span
              >
            </div>
            <div v-show="openGroups.has(idx)" class="am-log-group-items">
              <div
                v-for="entry in asGroup(item).entries"
                :key="entry.id"
                :class="`am-log-entry type-${String(entry.type).toLowerCase()}`"
              >
                <div
                  class="am-log-header"
                  :style="entry.details != null ? 'cursor:pointer' : ''"
                  @click="entry.details != null ? toggleDetails(entry.id) : undefined"
                >
                  <span class="am-log-time">{{ entry.time }}</span>
                  <span class="am-log-badge">{{ entry.type }}</span>
                  <span class="am-log-path" :title="entry.path">/{{ shortPath(entry.path) }}</span>
                  <span class="am-log-msg">{{ entry.message }}</span>
                  <div style="margin-left: auto; display: flex; gap: 8px; align-items: center">
                    <span
                      v-if="entry.stack"
                      class="am-log-btn-stack"
                      title="Показать Stack Trace"
                      @click.stop="toggleStack(entry.id)"
                      >[Stack]</span
                    >
                    <span
                      v-if="entry.details != null"
                      class="am-log-expand"
                      :style="openDetails.has(entry.id) ? 'transform:rotate(180deg)' : ''"
                      >▼</span
                    >
                  </div>
                </div>
                <div
                  v-if="entry.stack && openStacks.has(entry.id)"
                  class="am-log-stack-details"
                  style="
                    padding: 8px 12px;
                    background: rgba(252, 129, 129, 0.1);
                    border-top: 1px solid rgba(255, 255, 255, 0.05);
                  "
                >
                  <pre
                    style="
                      margin: 0;
                      font-size: 10.5px;
                      color: #f38ba8;
                      white-space: pre-wrap;
                      font-family: inherit;
                    "
                    >{{ entry.stack }}</pre>
                </div>
                <!-- v-html безопасен: jsonView экранирует всё через escapeHTML -->
                <div
                  v-if="entry.details != null && openDetails.has(entry.id)"
                  class="am-log-details"
                  v-html="safeJsonView(entry.details)"
                />
              </div>
            </div>
          </div>

          <!-- Одиночная запись -->
          <div
            v-else
            :class="`am-log-entry type-${String(asSingle(item).entry.type).toLowerCase()}`"
          >
            <div
              class="am-log-header"
              :style="asSingle(item).entry.details != null ? 'cursor:pointer' : ''"
              @click="
                asSingle(item).entry.details != null
                  ? toggleDetails(asSingle(item).entry.id)
                  : undefined
              "
            >
              <span class="am-log-time">{{ asSingle(item).entry.time }}</span>
              <span class="am-log-badge">{{ asSingle(item).entry.type }}</span>
              <span class="am-log-path" :title="asSingle(item).entry.path"
                >/{{ shortPath(asSingle(item).entry.path) }}</span
              >
              <span class="am-log-msg">{{ asSingle(item).entry.message }}</span>
              <div style="margin-left: auto; display: flex; gap: 8px; align-items: center">
                <span
                  v-if="asSingle(item).entry.stack"
                  class="am-log-btn-stack"
                  title="Показать Stack Trace"
                  @click.stop="toggleStack(asSingle(item).entry.id)"
                  >[Stack]</span
                >
                <span
                  v-if="asSingle(item).entry.details != null"
                  class="am-log-expand"
                  :style="
                    openDetails.has(asSingle(item).entry.id) ? 'transform:rotate(180deg)' : ''
                  "
                  >▼</span
                >
              </div>
            </div>
            <div
              v-if="asSingle(item).entry.stack && openStacks.has(asSingle(item).entry.id)"
              class="am-log-stack-details"
              style="
                padding: 8px 12px;
                background: rgba(252, 129, 129, 0.1);
                border-top: 1px solid rgba(255, 255, 255, 0.05);
              "
            >
              <pre
                style="
                  margin: 0;
                  font-size: 10.5px;
                  color: #f38ba8;
                  white-space: pre-wrap;
                  font-family: inherit;
                "
                >{{ asSingle(item).entry.stack }}</pre>
            </div>
            <!-- v-html безопасен: jsonView экранирует всё через escapeHTML -->
            <div
              v-if="
                asSingle(item).entry.details != null && openDetails.has(asSingle(item).entry.id)
              "
              class="am-log-details"
              v-html="safeJsonView(asSingle(item).entry.details)"
            />
          </div>
        </template>
      </div>

      <!-- Кнопка прокрутки к новым логам -->
      <button
        v-if="unreadCount > 0"
        style="
          position: absolute;
          bottom: 25px;
          right: 30px;
          background: #3dbbee;
          color: #fff;
          border: none;
          border-radius: 20px;
          padding: 8px 16px;
          cursor: pointer;
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
          font-weight: bold;
          z-index: 10;
          transition: 0.2s;
        "
        @click="scrollToBottom"
      >
        ⬇ Новые логи ({{ unreadCount }})
      </button>
    </div>
  </div>
</template>
