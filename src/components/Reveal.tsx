import { motion } from 'motion/react'
import type { ReactNode } from 'react'

// Fade-and-rise on scroll. Wrap any block; stagger siblings with `delay`.
export function Reveal({
  children,
  delay = 0,
  className,
  y = 18,
  once = true,
}: {
  children: ReactNode
  delay?: number
  className?: string
  y?: number
  once?: boolean
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: '0px 0px -10% 0px' }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
