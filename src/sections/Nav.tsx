import { AnimatePresence, motion } from 'motion/react'
import { Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../components/Button'
import { Logo } from '../components/Logo'
import { nav } from '../content'
import { cx } from '../lib/cx'

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <motion.nav
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className={cx(
          'relative flex h-14 w-full max-w-[1120px] items-center justify-between rounded-control-lg px-3 pl-4 transition-[background-color,box-shadow] duration-300',
          scrolled || open ? 'depth bg-bg/70 shadow-[0_10px_40px_-20px_rgb(0_0_0/0.8)] backdrop-blur-xl' : 'bg-transparent',
        )}
      >
        <Logo />
        <ul className="hidden items-center gap-1 md:flex">
          {nav.links.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                className="inline-flex h-9 items-center rounded-[12px] px-3 text-[14px] text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="hidden items-center gap-2 md:flex">
          <Button variant="ghost" href={nav.signIn.href} className="h-9 px-3 text-[14px]">
            {nav.signIn.label}
          </Button>
          <Button href={nav.cta.href} className="h-9 rounded-[12px] px-4 text-[14px]">
            {nav.cta.label}
          </Button>
        </div>
        <button
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="grid size-9 place-items-center rounded-[12px] text-fg transition-colors hover:bg-white/[0.06] md:hidden"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </motion.nav>

      <AnimatePresence>
        {open && (
          <motion.div
            key="sheet"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="depth absolute inset-x-4 top-[76px] rounded-card bg-surface p-3 shadow-glow md:hidden"
          >
            <ul className="flex flex-col">
              {nav.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex h-12 items-center rounded-control px-3 text-[16px] text-fg transition-colors hover:bg-white/[0.06]"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line pt-3">
              <Button variant="secondary" href={nav.signIn.href} onClick={() => setOpen(false)}>
                {nav.signIn.label}
              </Button>
              <Button href={nav.cta.href} onClick={() => setOpen(false)}>
                {nav.cta.label}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
