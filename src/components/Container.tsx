import type { ReactNode } from 'react'

import { cx } from '../lib/cx'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('mx-auto w-full max-w-[1120px] px-5 sm:px-8', className)}>{children}</div>
}
