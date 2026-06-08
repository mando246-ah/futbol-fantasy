const isDev = import.meta.env.DEV;

export function devLog(...args) {
  if (isDev) console.log(...args);
}

export function devWarn(...args) {
  if (isDev) console.warn(...args);
}

export function devError(...args) {
  if (isDev) console.error(...args);
}
