<script setup lang="ts">
// Читатель журнала. До него журнал писался в пустоту: Logger складывал записи
// в кольцевой буфер, registerLogSink не звал никто, а в консоль уходили только
// WARN и ERROR. Записи вида DB и API — те, по которым видно работу датасета
// и темп источников, — не доезжали никуда вовсе.
//
// Экран не отладочный по замыслу: замеры этапа 2 снимать больше нечем,
// а «пришлите, что в журнале» — единственный внятный вопрос человеку,
// у которого что-то не работает.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import { clearLogs, readLogs, registerLogSink, type LogEntry, type LogType } from '@/utils/logger'

/**
 * Виды записей для отбора. Порядок не алфавитный, а по частоте вопроса:
 * сначала «что сломалось», потом «что происходило».
 */
const KINDS: ReadonlyArray<LogType> = ['ERROR', 'WARN', 'INFO', 'API', 'DB', 'QUEUE']

/**
 * Сколько строк рисуем разом. Буфер вмещает пятьсот, но показ всех сразу
 * на приставке заметен глазом, а читают всегда свежие.
 */
const PAGE = 120

const rows = ref<LogEntry[]>([])
const kind = ref<LogType | 'all'>('all')
const limit = ref(PAGE)
const note = ref('')

/** Развёрнутые подробности: по номеру записи, а не флагом в самой записи. */
const opened = ref<Set<number>>(new Set())

/** Свежие сверху: читают последнее, а не первое. */
function fresh(all: ReadonlyArray<LogEntry>): LogEntry[] {
  const picked = kind.value === 'all' ? all : all.filter((entry) => entry.type === kind.value)
  return picked.slice(-limit.value).reverse()
}

function redraw(): void {
  rows.value = fresh(readLogs())
}

/**
 * Подписка на поток. Перерисовка идёт целиком, а не вставкой одной строки:
 * отбор и потолок показа всё равно считаются по всему буферу, а записей
 * в секунду тут единицы.
 */
function onEntry(): void {
  redraw()
}

function pick(next: LogType | 'all'): void {
  kind.value = next
  limit.value = PAGE
  note.value = ''
  redraw()
}

function onMore(): void {
  limit.value += PAGE
  redraw()
}

function toggle(id: number): void {
  const next = new Set(opened.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  opened.value = next
}

/** Подробности строкой. Ошибка разбора не должна ронять сам просмотрщик. */
function detailsText(entry: LogEntry): string {
  if (entry.details === null || entry.details === undefined) return ''

  try {
    return typeof entry.details === 'string'
      ? entry.details
      : JSON.stringify(entry.details, null, 2)
  } catch {
    return String(entry.details)
  }
}

function hasMore(entry: LogEntry): boolean {
  return detailsText(entry) !== '' || entry.stack !== ''
}

/**
 * Журнал в буфер обмена: человеку проще прислать текст, чем описывать
 * словами. Уходит то, что видно на экране, вместе с отбором.
 */
function onCopy(): void {
  const text = rows.value
    .map((entry) => {
      const head = `${entry.time} [${entry.type}] ${entry.message}`
      const tail = detailsText(entry)
      return tail === '' ? head : `${head}\n${tail}`
    })
    .join('\n\n')

  if (text === '') {
    note.value = 'Копировать нечего: журнал пуст.'
    return
  }

  void Bridge.clipboard
    .writeText(text)
    .then(() => {
      note.value = `Скопировано записей: ${rows.value.length}.`
    })
    .catch(() => {
      // Молчать нельзя: кнопка, которая не сработала и не сказала, выглядит поломкой.
      note.value = 'Буфер обмена недоступен.'
    })
}

function onClear(): void {
  clearLogs()
  opened.value = new Set()
  note.value = 'Журнал очищен.'
  redraw()
}

onMounted(() => {
  registerLogSink(onEntry)
  redraw()
})

onBeforeUnmount(() => {
  // Снимать обязательно: иначе подписка переживёт экран и будет дёргать
  // перерисовку выброшенных строк до конца жизни окна.
  registerLogSink(null)
})
</script>

<template>
  <section class="am-page">
    <div class="am-bar">
      <h2 class="am-h2">Журнал</h2>
      <span class="am-bar__gap" />
      <span class="am-meta">Записей: {{ rows.length }}</span>
    </div>

    <div class="am-seg am-log__kinds">
      <button
        class="am-seg__btn"
        :class="{ 'am-seg__btn--on': kind === 'all' }"
        type="button"
        @click="pick('all')"
      >
        Все
      </button>
      <button
        v-for="one in KINDS"
        :key="one"
        class="am-seg__btn"
        :class="{ 'am-seg__btn--on': kind === one }"
        type="button"
        @click="pick(one)"
      >
        {{ one }}
      </button>
    </div>

    <div class="am-log__tools">
      <button class="am-btn am-btn--soft" type="button" @click="onCopy">Скопировать</button>
      <button class="am-btn am-btn--ghost" type="button" @click="onClear">Очистить</button>
      <span v-if="note" class="am-meta">{{ note }}</span>
    </div>

    <div v-if="rows.length === 0" class="am-empty">
      <span class="am-empty__mark" aria-hidden="true">⊘</span>
      <span>Записей нет. Журнал пишется, пока открыто окно.</span>
    </div>

    <ul v-else class="am-log">
      <li v-for="entry in rows" :key="entry.id" class="am-panel am-log__row">
        <div class="am-log__head">
          <span class="am-log__kind" :data-kind="entry.type">{{ entry.type }}</span>
          <span class="am-log__time">{{ entry.time }}</span>
          <span class="am-log__text">{{ entry.message }}</span>
          <button
            v-if="hasMore(entry)"
            class="am-btn am-btn--ghost am-log__open"
            type="button"
            @click="toggle(entry.id)"
          >
            {{ opened.has(entry.id) ? 'Свернуть' : 'Подробнее' }}
          </button>
        </div>

        <pre v-if="opened.has(entry.id) && detailsText(entry) !== ''" class="am-log__body">{{
          detailsText(entry)
        }}</pre>
        <pre v-if="opened.has(entry.id) && entry.stack !== ''" class="am-log__body am-dim">{{
          entry.stack
        }}</pre>
      </li>
    </ul>

    <div v-if="rows.length >= limit" class="am-log__more">
      <button class="am-btn am-btn--soft" type="button" @click="onMore">Показать ещё</button>
    </div>
  </section>
</template>

<style scoped>
.am-log__kinds {
  margin-bottom: 10px;
}

.am-log__tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.am-log {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-log__row {
  padding: 8px 10px;
}

.am-log__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

/* Вид записи цветом: глаз находит ошибку в потоке быстрее, чем читает слово. */
.am-log__kind {
  flex: 0 0 auto;
  min-width: 54px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--am-faint);
}

.am-log__kind[data-kind='ERROR'] {
  color: var(--am-bad);
}

.am-log__kind[data-kind='WARN'] {
  color: var(--am-warn);
}

.am-log__kind[data-kind='DB'] {
  color: var(--am-good);
}

.am-log__kind[data-kind='API'] {
  color: var(--am-accent);
}

.am-log__time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-log__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--am-text);
  overflow-wrap: anywhere;
}

.am-log__open {
  flex: 0 0 auto;
}

/* Подробности переносятся: строка запроса длиннее окна, а горизонтальная
   прокрутка внутри списка ломает чтение остального. */
.am-log__body {
  margin: 8px 0 0;
  padding: 8px;
  border-radius: var(--am-r-s);
  background: var(--am-bg-2);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.am-log__more {
  display: flex;
  justify-content: center;
  padding: 10px 0;
}
</style>
