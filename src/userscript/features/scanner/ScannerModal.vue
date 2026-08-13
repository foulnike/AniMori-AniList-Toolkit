<!--
  Модалка сканера сравнения Shikimori ⇄ AniList.

  ГРАБЛИ: класс .amk-overlay в style.scss объявлен с display:none, показ раньше
  выставлялся императивно. При v-if это нужно задавать явно, поэтому на корне
  стоит inline style="display: flex". Не убирать до перевода amk-* в scoped.
-->
<script setup lang="ts">
import ScannerDiffCategory from './ScannerDiffCategory.vue'
import {
  addIgnore,
  alName,
  alPlaceholder,
  animeDiffCount,
  animeSections,
  cancelScan,
  closeScanner,
  deepCheck,
  favCounts,
  favIsEqual,
  favSections,
  hasResult,
  ignoreList,
  isScannerOpen,
  isScanning,
  mangaDiffCount,
  mangaSections,
  nameFavBlocks,
  progressLabel,
  removeIgnore,
  shikiLogin,
  startScan,
  statsAnime,
  statsManga,
  statusRows,
  statusText,
} from './scanner-state'

/** Дельта AniList − Shiki. Канон: плюс у положительных, пусто у нуля. */
function delta(shiki: number, al: number): string {
  const d = al - shiki
  if (d > 0) return '+' + d
  return d < 0 ? String(d) : ''
}

/** У строки «Всего» плюс не ставится. */
function totalDelta(shiki: number, al: number): string {
  const d = al - shiki
  return d !== 0 ? String(d) : ''
}

function mean(value: number): string {
  return value ? value.toFixed(2) : '—'
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) closeScanner()
}
</script>

<template>
  <div
    v-if="isScannerOpen"
    id="am-cmp-overlay"
    class="amk-overlay"
    style="display: flex"
    tabindex="-1"
    @click="onOverlayClick"
    @keydown.esc="closeScanner"
  >
    <div class="amk-modal amk-wide">
      <div class="amk-head">
        <h2 class="amk-title">
          <span class="amk-dot"></span
          ><span style="color: rgb(var(--color-pink))">Shikimori</span>&nbsp;⇄&nbsp;<span
            style="color: rgb(var(--color-blue))"
            >AniList</span
          >
          <span class="amk-sub">сравнение списков</span>
        </h2>
        <button id="am-cmp-close" class="amk-close" title="Закрыть" @click="closeScanner">✕</button>
      </div>

      <div class="amk-head" style="border-bottom: 1px solid rgba(var(--color-text-light), 0.06)">
        <input
          id="am-cmp-shiki"
          v-model="shikiLogin"
          class="amk-input"
          placeholder="Логин Shikimori"
          style="flex: 1; min-width: 150px; width: auto"
          @keydown.enter="startScan"
        /><input
          id="am-cmp-al"
          v-model="alName"
          class="amk-input"
          :placeholder="alPlaceholder"
          style="flex: 1; min-width: 150px; width: auto"
          @keydown.enter="startScan"
        /><label
          style="
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
          "
          title="Проверяет по каталогам обеих площадок наличие недостающих тайтлов. Медленнее (доп. запросы)."
          ><input id="am-cmp-deep" v-model="deepCheck" type="checkbox" /> Глубокая проверка</label
        ><button
          id="am-cmp-run"
          class="amk-btn amk-btn-primary"
          :disabled="isScanning"
          @click="startScan"
        >
          Сканировать</button
        ><button v-if="isScanning" class="amk-btn amk-btn-ghost" @click="cancelScan">
          Отменить
        </button>
      </div>

      <div
        id="am-cmp-status"
        style="
          padding: 8px 18px;
          font-size: 12px;
          color: rgb(var(--color-text-light));
          min-height: 18px;
          flex-shrink: 0;
        "
      >
        <span v-if="progressLabel" class="amk-count">{{ progressLabel }}</span>
        {{ statusText }}
      </div>

      <div id="am-cmp-result" class="amk-body" style="padding-top: 6px">
        <template v-if="hasResult">
          <div style="display: flex; gap: 20px; flex-wrap: wrap">
            <div style="flex: 1; min-width: 280px">
              <table v-if="statsAnime" class="amk-table" style="margin-bottom: 12px">
                <thead>
                  <tr>
                    <th>Аниме</th>
                    <th style="width: 70px; color: rgb(var(--color-pink))">Shiki</th>
                    <th style="width: 70px; color: rgb(var(--color-blue))">AniList</th>
                    <th style="width: 50px">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in statusRows" :key="row.key">
                    <td>{{ row.label }}</td>
                    <td>{{ statsAnime.shiki.byStatus[row.key] ?? 0 }}</td>
                    <td>{{ statsAnime.al.byStatus[row.key] ?? 0 }}</td>
                    <td style="color: rgb(var(--color-text-light))">
                      {{
                        delta(
                          statsAnime.shiki.byStatus[row.key] ?? 0,
                          statsAnime.al.byStatus[row.key] ?? 0,
                        )
                      }}
                    </td>
                  </tr>
                  <tr style="font-weight: 700">
                    <td>Всего</td>
                    <td>{{ statsAnime.shiki.total }}</td>
                    <td>{{ statsAnime.al.total }}</td>
                    <td>{{ totalDelta(statsAnime.shiki.total, statsAnime.al.total) }}</td>
                  </tr>
                  <tr>
                    <td>Средняя оценка</td>
                    <td>{{ mean(statsAnime.shiki.mean) }}</td>
                    <td>{{ mean(statsAnime.al.mean) }}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style="flex: 1; min-width: 280px">
              <table v-if="statsManga" class="amk-table" style="margin-bottom: 12px">
                <thead>
                  <tr>
                    <th>Манга</th>
                    <th style="width: 70px; color: rgb(var(--color-pink))">Shiki</th>
                    <th style="width: 70px; color: rgb(var(--color-blue))">AniList</th>
                    <th style="width: 50px">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in statusRows" :key="row.key">
                    <td>{{ row.label }}</td>
                    <td>{{ statsManga.shiki.byStatus[row.key] ?? 0 }}</td>
                    <td>{{ statsManga.al.byStatus[row.key] ?? 0 }}</td>
                    <td style="color: rgb(var(--color-text-light))">
                      {{
                        delta(
                          statsManga.shiki.byStatus[row.key] ?? 0,
                          statsManga.al.byStatus[row.key] ?? 0,
                        )
                      }}
                    </td>
                  </tr>
                  <tr style="font-weight: 700">
                    <td>Всего</td>
                    <td>{{ statsManga.shiki.total }}</td>
                    <td>{{ statsManga.al.total }}</td>
                    <td>{{ totalDelta(statsManga.shiki.total, statsManga.al.total) }}</td>
                  </tr>
                  <tr>
                    <td>Средняя оценка</td>
                    <td>{{ mean(statsManga.shiki.mean) }}</td>
                    <td>{{ mean(statsManga.al.mean) }}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="favCounts" style="margin-top: 6px">
            <div style="font-size: 13px; margin-bottom: 6px">
              Избранное — Аниме:
              <b style="color: rgb(var(--color-pink))">{{ favCounts.animeShiki }}</b> Shiki /
              <b style="color: rgb(var(--color-blue))">{{ favCounts.animeAl }}</b> AniList · Манга:
              <b style="color: rgb(var(--color-pink))">{{ favCounts.mangaShiki }}</b> /
              <b style="color: rgb(var(--color-blue))">{{ favCounts.mangaAl }}</b>
            </div>
            <ScannerDiffCategory
              v-for="section in favSections"
              :key="section.key"
              :label="section.label"
              :rows="section.rows"
              :sign="section.sign"
              :ignorable="section.ignorable"
              @ignore="addIgnore"
            />
            <div v-if="favIsEqual" style="opacity: 0.6; padding: 8px">Избранное совпадает.</div>
          </div>

          <div v-for="block in nameFavBlocks" :key="block.key">
            <div style="font-size: 13px; margin: 8px 0 4px">
              <b>{{ block.label }}</b> —
              <b style="color: rgb(var(--color-pink))">{{ block.shikiCount }}</b> Shiki /
              <b style="color: rgb(var(--color-blue))">{{ block.alCount }}</b> AniList
              <span style="opacity: 0.5">(матч по имени, приблизительно)</span>
            </div>
            <ScannerDiffCategory
              v-for="section in block.sections"
              :key="section.key"
              :label="section.label"
              :rows="section.rows"
              :sign="section.sign"
              :ignorable="section.ignorable"
            />
          </div>

          <h3 style="margin: 16px 0 4px; color: rgb(var(--color-text))">Аниме</h3>
          <ScannerDiffCategory
            v-for="section in animeSections"
            :key="section.key"
            :label="section.label"
            :rows="section.rows"
            :sign="section.sign"
            :ignorable="section.ignorable"
            @ignore="addIgnore"
          />
          <div v-if="animeDiffCount === 0" style="opacity: 0.6; padding: 8px">Расхождений нет.</div>

          <h3 style="margin: 16px 0 4px; color: rgb(var(--color-text))">Манга</h3>
          <ScannerDiffCategory
            v-for="section in mangaSections"
            :key="section.key"
            :label="section.label"
            :rows="section.rows"
            :sign="section.sign"
            :ignorable="section.ignorable"
            @ignore="addIgnore"
          />
          <div v-if="mangaDiffCount === 0" style="opacity: 0.6; padding: 8px">Расхождений нет.</div>

          <details v-if="ignoreList.length" class="amk-collapse">
            <summary>
              Игнорируемые <span class="amk-count">({{ ignoreList.length }})</span>
            </summary>
            <div class="amk-collapse-body">
              <div v-for="item in ignoreList" :key="item.signed" class="amk-diffrow">
                <span class="amk-name">{{ item.title }}</span>
                <span
                  class="cmp-unignore amk-x"
                  title="Вернуть"
                  style="color: rgb(var(--color-blue)); opacity: 0.85"
                  @click="removeIgnore(item.signed)"
                  >↩</span
                >
              </div>
            </div>
          </details>

          <div style="opacity: 0.5; font-size: 11px; margin-top: 14px; line-height: 1.5">
            «В списке только на одной площадке» — различие каталогов/списков, не ошибка синка.
            «Связано с уже отслеживаемым» — вероятно деление на сезоны или сиквелы (по связям
            AniList). Крестик ✕ — скрыть строку (игнор, запоминается). Даты не сравниваются. Оценки
            нормализованы к 10-балльной. Сопоставление по MAL id.
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
