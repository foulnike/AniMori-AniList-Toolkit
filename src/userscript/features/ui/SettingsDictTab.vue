<!--
  Панель «Словарь»: свои переводы поверх общего словаря, плюс импорт и экспорт.
  Идентификаторы am-dict-* и стили сохранены: на них ссылается style.scss.
  Строки словаря идут через :value и @change, а не v-model: иначе запись шла бы посимвольно.
-->
<template>
  <div class="amk-card">
    <div class="amk-card-title">Локальный словарь</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      Свои переводы поверх общего словаря. Применяются на странице сразу, без перезагрузки. Регистр
      сохраняется.
    </div>
    <div style="display: flex; gap: 8px; margin-bottom: 8px">
      <input
        class="amk-input"
        id="am-dict-src"
        placeholder="Оригинал (англ.)"
        style="flex: 1"
        v-model="dictSrcDraft"
      />
      <input
        class="amk-input"
        id="am-dict-tr"
        placeholder="Перевод (рус.)"
        style="flex: 1"
        v-model="dictTrDraft"
        @keydown.enter="addDictDraft()"
      />
      <button class="amk-btn amk-btn-primary" id="am-dict-add" @click="addDictDraft()">＋</button>
    </div>
    <input
      class="amk-input"
      id="am-dict-search"
      placeholder="Поиск по своим записям…"
      style="margin-bottom: 8px"
      v-model="dictSearch"
    />
    <div
      id="am-dict-list"
      style="display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto"
    >
      <div v-for="entry in filteredDictEntries" :key="entry.key" class="am-dict-row">
        <input
          class="amk-input"
          style="flex: 1"
          :value="entry.key"
          @change="onDictKeyChange(entry.key, entry.value, $event)"
        />
        <input
          class="amk-input"
          style="flex: 1"
          :value="entry.value"
          @change="onDictValueChange(entry.key, $event)"
        />
        <button
          class="amk-btn amk-btn-ghost am-dict-del"
          title="Удалить"
          @click="deleteDictEntry(entry.key)"
        >
          ✕
        </button>
      </div>
    </div>
    <div
      id="am-dict-empty"
      class="amk-row-hint"
      style="padding: 14px 2px; text-align: center"
      :style="{ display: dictTotal === 0 ? 'block' : 'none' }"
    >
      Пока нет своих записей. Добавьте перевод выше или выделите текст на странице.
    </div>
  </div>
  <div class="amk-card">
    <div class="amk-card-title">Импорт / Экспорт</div>
    <div style="display: flex; gap: 8px; flex-wrap: wrap">
      <button
        class="amk-btn amk-btn-ghost"
        id="am-dict-export"
        style="flex: 1"
        @click="exportDict()"
      >
        Экспорт
      </button>
      <button
        class="amk-btn amk-btn-ghost"
        id="am-dict-import"
        style="flex: 1"
        @click="importDictFromFile()"
      >
        Импорт
      </button>
      <button class="amk-btn amk-btn-ghost" id="am-dict-copy" style="flex: 1" @click="onDictCopy()">
        {{ dictCopyLabel }}
      </button>
    </div>
    <button
      class="amk-btn amk-btn-primary amk-btn-block"
      id="am-dict-share"
      style="
        margin-top: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      "
      @click="shareDict()"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </svg>
      Предложить в общую базу
    </button>
    <div class="amk-row-hint" style="padding: 8px 2px 2px; line-height: 1.5">
      Экспорт скачивает JSON, «Копировать» кладёт его в буфер для отправки другим. Импорт объединяет
      с текущими записями.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import {
  addDictDraft,
  commitDictEntry,
  copyDictToClipboard,
  deleteDictEntry,
  dictSearch,
  dictSrcDraft,
  dictTotal,
  dictTrDraft,
  exportDict,
  filteredDictEntries,
  importDictFromFile,
  shareDict,
} from './settings-state'

const dictCopyLabel = ref('Копировать')

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement ? el.value : ''
}

function onDictKeyChange(oldKey: string, value: string, e: Event): void {
  commitDictEntry(oldKey, inputValue(e), value)
}

function onDictValueChange(key: string, e: Event): void {
  commitDictEntry(key, key, inputValue(e))
}

function onDictCopy(): void {
  if (!copyDictToClipboard()) return
  dictCopyLabel.value = '✓ Скопировано'
  setTimeout(() => {
    dictCopyLabel.value = 'Копировать'
  }, 1400)
}
</script>
