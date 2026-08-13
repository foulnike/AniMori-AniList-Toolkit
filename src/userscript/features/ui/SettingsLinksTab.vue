<!--
  Панель «Ссылки»: тумблеры внешних источников, их домены и свои шаблоны адресов.
  Идентификаторы set_extlinks, set_link_*, set_*_domain и am-custom-* сохранены.
  Запись идёт по change, а не на каждое нажатие: normalizeDomain резал бы адрес на лету.
-->
<template>
  <div class="amk-card">
    <div class="amk-card-title">Внешние ссылки</div>
    <div class="amk-row">
      <span class="amk-row-label"><b>Показывать ссылки</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_extlinks" v-model="enableExtLinks" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
    <div class="amk-row">
      <span class="amk-row-label"><b>RuTracker</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_link_rutracker" v-model="enableLinkRutracker" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
    <div class="amk-row">
      <span class="amk-row-label"><b>YummyAnime</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_link_yummy" v-model="enableLinkYummy" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
    <input
      class="amk-input amk-mono"
      id="set_yummy_domain"
      placeholder="yummyanime.tv"
      style="margin: 2px 0 8px"
      :value="yummyDomain"
      @change="onDomainChange('yummy', $event)"
    />
    <div class="amk-row">
      <span class="amk-row-label"><b>AnimeGO</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_link_animego" v-model="enableLinkAnimego" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
    <input
      class="amk-input amk-mono"
      id="set_animego_domain"
      placeholder="animego.org"
      style="margin: 2px 0 8px"
      :value="animegoDomain"
      @change="onDomainChange('animego', $event)"
    />
    <div class="amk-row">
      <span class="amk-row-label"><b>MangaLib</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_link_mangalib" v-model="enableLinkMangalib" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
    <input
      class="amk-input amk-mono"
      id="set_mangalib_domain"
      placeholder="mangalib.me"
      style="margin: 2px 0 6px"
      :value="mangalibDomain"
      @change="onDomainChange('mangalib', $event)"
    />
  </div>

  <div class="amk-card">
    <div class="amk-card-title">Свои ссылки</div>
    <div id="am-custom-links-list" style="display: flex; flex-direction: column; gap: 10px">
      <div v-for="(link, index) in customLinks" :key="index" class="am-cl-row">
        <div style="display: flex; gap: 8px; align-items: center">
          <input
            class="amk-input"
            placeholder="Название"
            style="flex: 1"
            :value="link.name"
            @change="onLinkFieldChange(index, 'name', $event)"
          />
          <button
            class="amk-btn amk-btn-ghost am-cl-del"
            title="Удалить"
            @click="removeCustomLink(index)"
          >
            ✕
          </button>
        </div>
        <input
          class="amk-input amk-mono"
          :placeholder="CUSTOM_URL_EXAMPLE"
          style="margin-top: 6px"
          :value="link.url"
          @change="onLinkFieldChange(index, 'url', $event)"
        />
        <div class="am-cl-swatches">
          <span
            v-for="color in CL_COLORS"
            :key="color"
            class="am-cl-sw"
            :class="{ active: link.color === color }"
            :style="{ background: 'rgb(' + color + ')' }"
            @click="setCustomLinkColor(index, color)"
          ></span>
        </div>
      </div>
    </div>
    <button
      class="amk-btn amk-btn-ghost"
      id="am-custom-add"
      style="width: 100%; margin-top: 10px"
      @click="addCustomLink()"
    >
      ＋ Добавить свою ссылку
    </button>
    <div class="amk-row-hint" style="padding: 10px 2px 2px; line-height: 1.5">
      В URL-шаблоне подставляются:
      <code
        style="
          background: rgba(var(--color-text-light), 0.12);
          padding: 1px 5px;
          border-radius: 4px;
        "
        >{ru}</code
      >
      — русское название,
      <code
        style="
          background: rgba(var(--color-text-light), 0.12);
          padding: 1px 5px;
          border-radius: 4px;
        "
        >{romaji}</code
      >
      — ромадзи,
      <code
        style="
          background: rgba(var(--color-text-light), 0.12);
          padding: 1px 5px;
          border-radius: 4px;
        "
        >{query}</code
      >
      — авто (ru → romaji). Всё кодируется автоматически.
    </div>
  </div>
</template>

<script setup lang="ts">
import { CL_COLORS } from '../../core/custom-links'
import {
  CUSTOM_URL_EXAMPLE,
  addCustomLink,
  animegoDomain,
  customLinks,
  enableExtLinks,
  enableLinkAnimego,
  enableLinkMangalib,
  enableLinkRutracker,
  enableLinkYummy,
  mangalibDomain,
  normalizeDomain,
  persistCustomLinks,
  removeCustomLink,
  setCustomLinkColor,
  yummyDomain,
} from './settings-state'

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement ? el.value : ''
}

function onDomainChange(which: 'yummy' | 'animego' | 'mangalib', e: Event): void {
  const normalized = normalizeDomain(inputValue(e))
  if (which === 'yummy') yummyDomain.value = normalized
  else if (which === 'animego') animegoDomain.value = normalized
  else mangalibDomain.value = normalized
}

function onLinkFieldChange(index: number, field: 'name' | 'url', e: Event): void {
  const link = customLinks.value[index]
  if (!link) return
  link[field] = inputValue(e).trim()
  persistCustomLinks()
}
</script>
