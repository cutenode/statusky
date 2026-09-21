import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Adds a bindable `ref` to a component's props, the way shadcn-svelte components do. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null
}

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T
export type WithoutChildren<T> = Omit<T, 'children'>
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>
