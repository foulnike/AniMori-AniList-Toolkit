// Пункт 2.2: единственное место в разметке, которое знает про вызовы Rust.
// Экраны видят только authStatus и пару функций — так же, как в юзерскрипте
// вся платформа спрятана за мостом.
//
// Самого токена здесь нет и не будет: он живёт в Rust (src-tauri/src/auth.rs),
// а запросы к API пойдут оттуда же в пункте 2.3.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { computed, ref, type ComputedRef } from 'vue'

/// Форма ответа команд входа. Совпадает с AuthStatus в auth.rs.
export type AuthStatus = {
  authorized: boolean
  /// Секунды эпохи Unix. null — срок неизвестен.
  expiresAt: number | null
}

/// Ответ на начало входа. Совпадает с LoginStart в auth.rs.
export type LoginStart = {
  /// Адрес для этого же компьютера: браузер открылся им.
  localUrl: string
  /// Адрес в домашней сети. null — сети нет, вход с телефона невозможен.
  lanUrl: string | null
  /// Картинка QR для домашнего адреса, готовый SVG из Rust.
  qrSvg: string | null
  /// Сколько секунд приёмник ждёт пропуск.
  waitSecs: number
}

// Повторяет EVENT_CHANGED в auth.rs: два места расходиться не должны.
const EVENT_CHANGED = 'animori://auth-changed'

const state = ref<AuthStatus>({ authorized: false, expiresAt: null })

export const authStatus: ComputedRef<AuthStatus> = computed(() => state.value)

/// В браузере (npm run dev:app) моста нет, и вызов invoke упал бы с ошибкой
/// при первой же отрисовке настроек. Лучше сказать об этом вслух.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/// Спросить состояние входа у Rust. Зовётся при открытии настроек.
export async function refreshAuth(): Promise<void> {
  if (!isDesktop()) return
  state.value = await invoke<AuthStatus>('animori_auth_status')
}

/// Начать вход: Rust поднимает приёмник и открывает браузер. Токена в
/// ответе нет и быть не может: об успехе сообщит событие.
export async function startLogin(): Promise<LoginStart> {
  return invoke<LoginStart>('animori_auth_start')
}

/// Запасной путь: токен, вставленный руками. Срок не передаётся: его нет
/// ни в токене, ни у человека перед глазами.
export async function submitToken(token: string): Promise<void> {
  state.value = await invoke<AuthStatus>('animori_auth_submit', { token, expiresIn: null })
}

/// Выйти из аккаунта.
export async function logout(): Promise<void> {
  state.value = await invoke<AuthStatus>('animori_auth_logout')
}

/// Подписка на событие входа. Возвращает отключатель — так же, как startRouter.
export async function watchAuth(): Promise<() => void> {
  if (!isDesktop()) return () => {}

  return listen<AuthStatus>(EVENT_CHANGED, (event) => {
    state.value = event.payload
  })
}
