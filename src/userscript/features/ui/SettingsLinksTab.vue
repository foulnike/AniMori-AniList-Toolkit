<!--
  Панель «Ссылки»: тумблеры внешних источников и их домены.
  Идентификаторы set_extlinks, set_link_* и set_*_domain сохранены.
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
</template>

<script setup lang="ts">
import {
  animegoDomain,
  enableExtLinks,
  enableLinkAnimego,
  enableLinkMangalib,
  enableLinkRutracker,
  enableLinkYummy,
  mangalibDomain,
  normalizeDomain,
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
</script>
