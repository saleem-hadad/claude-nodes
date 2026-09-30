import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { FolderColor } from '@shared/types'

interface Hues {
  backTop: string
  backBottom: string
  frontTop: string
  frontBottom: string
  /** Colour of the embossed glyph stamped on the front panel. */
  glyph: string
}

/** Folder hues modelled on the macOS tag colours. The front-top hue doubles as the swatch colour. */
export const FOLDER_HUES: Record<FolderColor, Hues> = {
  blue: {
    backTop: '#3aa8f0',
    backBottom: '#1d8be0',
    frontTop: '#6dd0fc',
    frontBottom: '#2da4f3',
    glyph: '#1478c8'
  },
  purple: {
    backTop: '#a67ae8',
    backBottom: '#8b5bd9',
    frontTop: '#c8a2f7',
    frontBottom: '#a77beb',
    glyph: '#7447c4'
  },
  pink: {
    backTop: '#f06fa8',
    backBottom: '#e0508f',
    frontTop: '#fba0c8',
    frontBottom: '#f074aa',
    glyph: '#c83a78'
  },
  red: {
    backTop: '#f2615a',
    backBottom: '#e0443e',
    frontTop: '#ff9189',
    frontBottom: '#f76760',
    glyph: '#c4302b'
  },
  orange: {
    backTop: '#fa9d3a',
    backBottom: '#ee8420',
    frontTop: '#ffc374',
    frontBottom: '#fba343',
    glyph: '#d06d10'
  },
  yellow: {
    backTop: '#f5c73a',
    backBottom: '#e6b020',
    frontTop: '#ffe27a',
    frontBottom: '#f9cb45',
    glyph: '#be8e0c'
  },
  green: {
    backTop: '#5cc96a',
    backBottom: '#3db352',
    frontTop: '#93e19c',
    frontBottom: '#5dcd6b',
    glyph: '#2a9340'
  },
  graphite: {
    backTop: '#8e8e93',
    backBottom: '#76767b',
    frontTop: '#bdbdc2',
    frontBottom: '#9a9aa0',
    glyph: '#636368'
  }
}

export const FOLDER_COLORS = Object.keys(FOLDER_HUES) as FolderColor[]

interface Props {
  size?: number
  color?: FolderColor
  /** A letter or a lucide icon, embossed on the front panel like macOS special folders. */
  glyph?: string | LucideIcon
  className?: string
}

// Back panel with the tab on the top-left, drawn in a 128×128 box.
const BACK_PATH =
  'M10 30C10 23.4 15.4 18 22 18H46C49.5 18 52.6 19.6 54.8 22.3L58 26.2C59.8 28.3 62.4 29.5 65.2 29.5H108C114.6 29.5 118 33 118 39.5V100C118 106.6 114.6 110 108 110H20C13.4 110 10 106.6 10 100Z'

const GLYPH_CX = 64
const GLYPH_CY = 75
const GLYPH_SIZE = 30

/** The modern macOS folder, drawn as SVG so it scales from 16px breadcrumbs to large grid icons. */
export function FolderIcon({ size = 64, color = 'blue', glyph, className }: Props) {
  const uid = useId().replace(/:/g, '')
  const hues = FOLDER_HUES[color] ?? FOLDER_HUES.blue
  const id = (name: string) => `folder-${name}-${uid}`
  const small = size < 32

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <linearGradient id={id('back')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hues.backTop} />
          <stop offset="1" stopColor={hues.backBottom} />
        </linearGradient>
        <linearGradient id={id('front')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hues.frontTop} />
          <stop offset="1" stopColor={hues.frontBottom} />
        </linearGradient>
        <linearGradient id={id('sheen')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.05" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={id('shadow')} x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.2" />
        </filter>
      </defs>

      <g filter={small ? undefined : `url(#${id('shadow')})`}>
        <path d={BACK_PATH} fill={`url(#${id('back')})`} />
        <rect x="10" y="39" width="108" height="71" rx="9" fill={`url(#${id('front')})`} />
        <rect x="10" y="39" width="108" height="71" rx="9" fill={`url(#${id('sheen')})`} />
        <path
          d="M19 39.8H109"
          stroke="#fff"
          strokeOpacity="0.6"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </g>

      {glyph && !small && <Glyph glyph={glyph} color={hues.glyph} />}
    </svg>
  )
}

function Glyph({ glyph, color }: { glyph: string | LucideIcon; color: string }) {
  // Two copies give the stamped look: a light edge below, the tinted glyph on top.
  if (typeof glyph === 'string') {
    const common = {
      x: GLYPH_CX,
      textAnchor: 'middle' as const,
      dominantBaseline: 'central' as const,
      fontSize: 34,
      fontWeight: 600,
      fontFamily: "'SF Pro Rounded', -apple-system, BlinkMacSystemFont, sans-serif"
    }
    const letter = glyph.slice(0, 1).toUpperCase()
    return (
      <g>
        <text {...common} y={GLYPH_CY + 1.2} fill="#fff" fillOpacity="0.35">
          {letter}
        </text>
        <text {...common} y={GLYPH_CY} fill={color} fillOpacity="0.62">
          {letter}
        </text>
      </g>
    )
  }

  const Icon = glyph
  const box = {
    x: GLYPH_CX - GLYPH_SIZE / 2,
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    strokeWidth: 2.4
  }
  return (
    <g>
      <Icon {...box} y={GLYPH_CY - GLYPH_SIZE / 2 + 1.2} color="#fff" opacity={0.35} />
      <Icon {...box} y={GLYPH_CY - GLYPH_SIZE / 2} color={color} opacity={0.62} />
    </g>
  )
}
