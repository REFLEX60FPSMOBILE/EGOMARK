import { AnimatePresence, motion } from 'motion/react'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import { Container } from '../components/Container'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { faq } from '../content'
import { cx } from '../lib/cx'

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section className="border-t border-line py-24 sm:py-32">
      <Container className="max-w-[760px]">
        <SectionHeading title={faq.title} />
        <Reveal className="mt-12">
          <ul className="depth relative divide-y divide-line rounded-card bg-surface shadow-glow">
            {faq.items.map((item, i) => {
              const isOpen = open === i
              return (
                <li key={item.q}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : i)}
                    className="flex w-full items-center justify-between gap-6 px-6 py-5 text-left"
                  >
                    <span className="text-[16px] font-medium">{item.q}</span>
                    <span
                      className={cx(
                        'depth relative grid size-7 shrink-0 place-items-center rounded-[9px] text-muted transition-transform duration-300',
                        isOpen && 'rotate-45 text-fg',
                      )}
                    >
                      <Plus className="size-3.5" />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        key="body"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <p className="px-6 pb-6 text-[15px] leading-relaxed text-muted">{item.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              )
            })}
          </ul>
        </Reveal>
      </Container>
    </section>
  )
}
