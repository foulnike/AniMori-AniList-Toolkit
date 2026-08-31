<script setup lang="ts">
// Описание разметкой источника: начертания, перекрёстные ссылки, спойлеры,
// цитаты и списки. Разбор живёт в core/rich-text.ts, здесь только показ.
//
// Компонент зовёт себя сам: внутри спойлера и цитаты лежат такие же блоки,
// и второй способ их нарисовать разошёлся бы с первым на первой же правке.
import { computed, ref } from 'vue'

import { parseRich, type RichAim, type RichBlock, type RichPart } from '@/core/rich-text'

import { followRichAim } from '../rich-open'

const props = defineProps<{
  /** Сырое описание: разбирается здесь. */
  text?: string | null
  /** Уже разобранные блоки: так компонент зовёт себя для вложенного уровня. */
  blocks?: RichBlock[]
}>()

/** Внутренний переход состоялся: окошку человека пора закрыться. */
const emit = defineEmits<{ (e: 'inside'): void }>()

/** Раскрытые спойлеры этого уровня: ключ — место блока в списке. */
const open = ref(new Set<number>())

const blocks = computed<RichBlock[]>(() => props.blocks ?? parseRich(props.text))

/** Начертания куска: классы вместо стилей в разметке — тема решает вид. */
function faceClass(part: RichPart): Record<string, boolean> {
  return {
    'am-rich--b': part.face.bold === true,
    'am-rich--i': part.face.italic === true,
    'am-rich--s': part.face.strike === true,
    'am-rich--u': part.face.under === true,
  }
}

function shown(at: number): boolean {
  return open.value.has(at)
}

/** Спойлер раскрывается нажатием и закрывается им же. */
function toggle(at: number): void {
  const next = new Set(open.value)
  if (next.has(at)) next.delete(at)
  else next.add(at)
  open.value = next
}

async function follow(aim: RichAim): Promise<void> {
  if (await followRichAim(aim)) emit('inside')
}
</script>

<template>
  <div class="am-rich">
    <template v-for="(block, at) in blocks" :key="at">
      <p v-if="block.kind === 'para'" class="am-rich__para">
        <template v-for="(part, i) in block.parts" :key="i">
          <a
            v-if="part.kind === 'link'"
            class="am-rich__link"
            :class="faceClass(part)"
            href="#"
            @click.prevent="void follow(part.aim)"
            >{{ part.text }}</a
          >
          <span v-else :class="faceClass(part)">{{ part.text }}</span>
        </template>
      </p>

      <div v-else-if="block.kind === 'spoiler'" class="am-rich__spoil">
        <button
          class="am-rich__reveal"
          type="button"
          :aria-expanded="shown(at)"
          @click="toggle(at)"
        >
          <span class="am-rich__mark" aria-hidden="true">{{ shown(at) ? '▾' : '▸' }}</span>
          <span>{{ block.label === '' ? 'Спойлер' : block.label }}</span>
        </button>

        <RichText v-if="shown(at)" :blocks="block.blocks" @inside="emit('inside')" />
      </div>

      <blockquote v-else-if="block.kind === 'quote'" class="am-rich__quote">
        <p v-if="block.who" class="am-rich__who">{{ block.who }}</p>
        <RichText :blocks="block.blocks" @inside="emit('inside')" />
      </blockquote>

      <ul v-else-if="block.kind === 'list'" class="am-rich__list">
        <li v-for="(item, i) in block.items" :key="i">
          <template v-for="(part, j) in item" :key="j">
            <a
              v-if="part.kind === 'link'"
              class="am-rich__link"
              :class="faceClass(part)"
              href="#"
              @click.prevent="void follow(part.aim)"
              >{{ part.text }}</a
            >
            <span v-else :class="faceClass(part)">{{ part.text }}</span>
          </template>
        </li>
      </ul>

      <img
        v-else-if="block.kind === 'image'"
        class="am-rich__art"
        :src="block.url"
        alt=""
        loading="lazy"
        decoding="async"
      />

      <hr v-else-if="block.kind === 'rule'" class="am-rich__rule" />
    </template>
  </div>
</template>

<style scoped>
/* Зазор между блоками держит раскладка: у абзацев маргины сняты, иначе
   спойлер и цитата вставали то вплотную, то с двойным отступом. */
.am-rich {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* Переносы источника сохраняются: описания набирают строками, и склейка
   в одну простыню теряет и стихи, и перечисления без тегов. */
.am-rich__para {
  margin: 0;
  white-space: pre-line;
}

.am-rich--b {
  font-weight: 700;
}

.am-rich--i {
  font-style: italic;
}

.am-rich--s {
  text-decoration: line-through;
}

.am-rich--u {
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Ссылка внутрь и наружу выглядит одинаково: разница видна по тому, куда
   она привела, а два вида подчёркивания в одном абзаце только шумят. */
.am-rich__link {
  color: var(--am-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  transition: color var(--am-fast) var(--am-ease);
}

.am-rich__link:hover,
.am-rich__link:focus-visible {
  color: var(--am-accent);
}

/* Спойлер: своя рамка, чтобы скрытое было видно как отдельный кусок. */
.am-rich__spoil {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 12px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-rich__reveal {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  align-self: flex-start;
  padding: 5px 12px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-rich__reveal:hover,
.am-rich__reveal:focus-visible {
  color: var(--am-text);
  background: var(--am-hover);
}

/* Значок раскрытия стоит в своей клетке: иначе строка дёргалась при смене
   треугольника на другой. */
.am-rich__mark {
  display: grid;
  place-items: center;
  width: 10px;
  font-size: 10px;
}

.am-rich__quote {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 4px 0 4px 12px;
  border-left: 2px solid rgb(var(--am-accent-rgb) / 0.5);
}

.am-rich__who {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--am-faint);
}

.am-rich__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 20px;
}

/* Картинка из описания вписывается в колонку: у источника они бывают
   в полный размер экрана. */
.am-rich__art {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-rich__rule {
  width: 100%;
  height: 1px;
  margin: 2px 0;
  background: var(--am-line-soft);
  border: 0;
}
</style>
