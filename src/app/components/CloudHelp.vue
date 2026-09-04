<script setup lang="ts">
// Подробная инструкция к облачной копии. Отдельным узлом и модалкой,
// а не абзацами в панели: панель читают глазами по кнопкам, а инструкцию —
// один раз, когда что-то не сошлось. Абзацы в панели этот один раз
// оплачивали каждым открытием настроек.
//
// Своего состояния узел не держит вовсе: открыт он или нет решает тот,
// кто нажимал кнопку, путь к файлу копии приходит свойством, всё прочее
// здесь — неизменный текст. Ломаться тут нечему.
//
// Уводится в body нарочно: панель настроек лежит внутри прокручиваемого
// экрана, а position: fixed внутри предка с transform считается от предка,
// и модалка уезжала бы вместе с прокруткой.
import { onBeforeUnmount, watch } from 'vue'

import { Bridge } from '@/bridge'

const props = defineProps<{
  /** Открыта ли модалка. */
  open: boolean
  /** Путь к файлу копии: спрашивается у ядра, а не переписывается здесь. */
  path: string
}>()

const emit = defineEmits<{ close: [] }>()

/** Где человек заводит своё приложение Яндекса и берёт пропуск. */
const YANDEX_OAUTH_URL = 'https://oauth.yandex.com/client/new/'

/// Внешние адреса открывает оболочка: target="_blank" в WebView2
/// отбрасывается молча, без окна и без ошибки.
function onOauth(): void {
  void Bridge.shell.openExternal(YANDEX_OAUTH_URL)
}

function onClose(): void {
  emit('close')
}

/// Esc закрывает: модалка перекрывает экран целиком, а на пульте мышью
/// до крестика не добраться вовсе.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') onClose()
}

// Слушатель живёт только пока модалка открыта: висящий на document
// обработчик закрытого окна перехватывал бы Esc у экранов под ним.
watch(
  () => props.open,
  (open) => {
    if (open) document.addEventListener('keydown', onKey)
    else document.removeEventListener('keydown', onKey)
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="am-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Облачная копия: как это работает"
    >
      <!-- Клик мимо закрывает: это справка, и держать её силой незачем. -->
      <div class="am-modal__veil" @click="onClose" />

      <div class="am-modal__box">
        <div class="am-modal__head">
          <h3 class="am-modal__title">Облачная копия: как это работает</h3>
          <button class="am-modal__x" type="button" aria-label="Закрыть" @click="onClose">✕</button>
        </div>

        <div class="am-modal__body">
          <p>
            Копия — это один файл с вашим списком в папке приложения на вашем Яндекс Диске.
            Программа не отправляет и не забирает его сама: каждое действие — нажатая вами кнопка.
            Ни AniList, ни Шикимори при этом не трогаются.
          </p>

          <h4 class="am-modal__h">Один раз: пропуск</h4>
          <p>
            Готовых пропусков Яндекс не выдаёт, а своего приложения внутри программы нет нарочно:
            общий на всех ключ — это чужая головная боль и один рубильник на всех пользователей.
            Поэтому приложение вы заводите своё, за пять минут:
          </p>
          <ol>
            <li>
              Откройте
              <button class="am-modal__link" type="button" @click="onOauth">oauth.yandex.com</button>
              и создайте приложение с любым названием.
            </li>
            <li>Платформа — «Веб-сервисы», Redirect URI — кнопка «Подставить URL для отладки».</li>
            <li>Права — «Приложения на Диске» (<code>cloud_api:disk.app_folder</code>). Больше ничего не нужно: за пределы своей папки программа не ходит.</li>
            <li>
              Скопируйте ClientID приложения и откройте в браузере
              <code>https://oauth.yandex.ru/authorize?response_type=token&amp;client_id=ВАШ_ID</code>.
              Яндекс вернёт пропуск прямо в адресной строке, после <code>access_token=</code>.
            </li>
            <li>Вставьте его в поле «Пропуск Яндекс Диска» и нажмите «Проверить и сохранить».</li>
          </ol>
          <p>
            Пропуск остаётся на этом устройстве, в файле настроек программы. В копию списка он
            не попадает никогда. Проверка идёт до сохранения: негодную строку программа
            не запомнит и не соврёт, что облако подключено.
          </p>

          <h4 class="am-modal__h">Файл копии</h4>
          <p>
            Лежит по пути <code>{{ path }}</code> — это папка приложения, её видно на Диске
            в разделе «Приложения». Файл один и перезаписывается на месте: истории версий
            программа не ведёт, её ведёт сам Диск.
          </p>

          <h4 class="am-modal__h">Каждый день: две кнопки</h4>
          <p>
            <b>Сохранить</b> — список уходит в облако. <b>Забрать</b> — копия возвращается
            и всегда спрашивает, как её положить:
          </p>
          <ul>
            <li><b>Добавить недостающее</b> — берёт из копии то, чего здесь нет, ваши правки остаются.</li>
            <li><b>Заменить целиком</b> — список становится ровно таким, как в копии. Всё, что было набрано здесь и не попало в копию, исчезнет.</li>
          </ul>

          <h4 class="am-modal__h">Чужую копию не затрёт</h4>
          <p>
            Программа помнит время правки файла, каким его назвал сам Диск после нашей записи.
            Если файл изменил кто-то другой — второе устройство или вы с другой машины, — запись
            останавливается и спрашивает: показывает размер и время чужой копии и предлагает
            сперва забрать её. Молча затереть список с другого устройства она не может.
          </p>

          <h4 class="am-modal__h">Ссылка для телевизора</h4>
          <p>
            Пропуск — строка под шесть десятков знаков, и пультом её не набрать. Поэтому
            у копии есть второй конец: кнопка «Создать ссылку» публикует файл и показывает адрес.
            На телевизоре набирать нужно не весь адрес, а только хвост — десяток знаков после
            последней косой черты.
          </p>
          <p>
            Чтение по ссылке не требует ни пропуска, ни выбранного облака: поле «Забрать
            по ссылке» внизу панели работает на чистой установке. Сначала по ссылке
            спрашиваются размер и время копии, и только потом предлагается её положить.
          </p>
          <p>
            Дорога односторонняя: по ссылке копию можно только прочитать. Записывает её
            то устройство, где сохранён пропуск.
          </p>
          <div class="am-modal__warn">
            По ссылке копию прочитает любой, кто её знает: имя устройства, оценки и заметки
            в ней открыты. Держите её при себе, а когда перенос закончен — нажмите «Закрыть
            доступ». Файл копии при этом остаётся на месте. У публичных ссылок Яндекса есть
            и суточный предел скачиваний: при частом опросе Диск отвечает отказом до утра.
          </div>

          <h4 class="am-modal__h">Отключение</h4>
          <p>
            «Отключить облако» забывает пропуск и память о чужой копии. Файл на Диске остаётся
            нетронутым: стирать чужое хранилище по кнопке «отключить» программа не вправе.
            Удалить файл можно самому — через сайт или приложение Диска.
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Модалка на весь экран: сама справка узкая, но подложка обязана перекрыть
   всё, иначе клик мимо уходит в панель под ней. */
.am-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 24px;
}

/* Подложка красится темой, а не чёрным литералом: на светлой теме чёрная
   вуаль читалась провалом в экране. */
.am-modal__veil {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--am-bg) 76%, transparent);
  backdrop-filter: blur(var(--am-blur-strong));
}

.am-modal__box {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(760px, 88vh);
  background: var(--am-panel-2);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-2);
  animation: am-modal-in var(--am-mid) var(--am-ease) both;
}

@keyframes am-modal-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.am-modal__head {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: center;
  padding: 15px 15px 13px 18px;
  border-bottom: 1px solid var(--am-line-soft);
}

.am-modal__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--am-text);
}

.am-modal__x {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-modal__x:hover {
  color: var(--am-text);
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
}

/* Текст справки прокручивается внутри рамки: длинную инструкцию иначе
   пришлось бы резать, а резать её незачем — читают её один раз. */
.am-modal__body {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 16px 18px 20px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--am-dim);
}

.am-modal__body p {
  margin: 0;
}

.am-modal__body b {
  color: var(--am-text);
}

.am-modal__h {
  margin: 7px 0 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--am-text);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.am-modal__body ol,
.am-modal__body ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
}

/* Адреса и права в тексте — набранные, а не пересказанные: их копируют
   в браузер и в консоль Яндекса, и любая вольность пересказа стоит
   человеку получаса. Перенос по любому месту обязателен: ссылка
   с ClientID в одну строку панели не встаёт. */
.am-modal__body code {
  padding: 1px 6px;
  font-size: 12px;
  background: var(--am-fill-2);
  border-radius: var(--am-r-s);
  overflow-wrap: anywhere;
}

/* Предупреждение тем же тоном, что и вопросы в панели: это не поломка,
   и красным его показывать неправильно. */
.am-modal__warn {
  padding: 11px 13px;
  background: color-mix(in srgb, var(--am-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 42%, transparent);
  border-radius: var(--am-r-m);
}

.am-modal__link {
  padding: 0;
  font: inherit;
  color: var(--am-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  background: none;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .am-modal__box {
    animation: none;
  }
}
</style>
