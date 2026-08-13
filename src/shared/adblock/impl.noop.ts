// Юзерскриптная цель псевдопути '@adblock-impl': заглушки вместо блокировщика.
//
// Почему заглушки, а не удалённые вызовы в точке входа: ни main.ts, ни панель настроек
// не должны знать о платформе. Сигнатуры совпадают с impl.desktop.ts, поэтому обе цели
// проверяются тайпчекером одинаково, а расхождение сигнатур станет ошибкой сборки.
//
// Разведка (net-probe) заглушена по той же причине: без сетевого блокировщика собранный
// ею список адресов применять нечем, а её горячие клавиши отбирали бы у браузера
// Ctrl+Shift+S и Ctrl+Shift+A прямо на anilist.co.

export function initAdblock(): void {
  /* в браузере рекламу режет расширение пользователя */
}

export function destroyAdblock(): void {
  /* нечего разбирать */
}

export function syncAdblock(): void {
  /* тумблера в браузерной сборке нет */
}

export function getBlockedCount(): number {
  return 0
}

export function initNetProbe(): void {
  /* разведка только в десктопной сборке */
}

export function destroyNetProbe(): void {
  /* нечего разбирать */
}
