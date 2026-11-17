// PNG rank card for `/level rank`. Pure steps: build the numbers, lay them out as SVG (satori),
// rasterize with resvg. The bot runs this file from source via tsx (`tsc` is `noEmit`; there is no
// plugins bundle). The Docker image copies the repo, so the fonts next to this module and
// `@resvg/resvg-wasm`'s `index_bg.wasm` are the files used at runtime.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { levelProgress } from './service';

const CARD_WIDTH = 900;
const CARD_HEIGHT = 280;
const AVATAR_SIZE = 128;
const TEXT_WIDTH = 640;

const COLOR = {
  background: '#14110e',
  accent: '#c7933d',
  text: '#f6f1e7',
  muted: '#b7aa93',
  track: '#3a3328',
  placeholder: '#2a241c',
} as const;

export interface RankCardInput {
  displayName: string;
  /** 1-based leaderboard position. */
  rank: number;
  /** Lifetime XP. Level and the progress bar are derived from this. */
  xp: number;
  /** Raw avatar bytes (PNG, JPEG, GIF, or WebP). Missing or unrecognized bytes draw a monogram. */
  avatar?: Uint8Array | null;
}

export interface RankCardModel {
  displayName: string;
  rankLabel: string;
  levelLabel: string;
  progressLabel: string;
  totalLabel: string;
  /** 0–1, share of the current level that is already earned. */
  progress: number;
  avatarSrc: string | null;
  initial: string;
}

interface CardNode {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: CardNode | CardNode[] | string;
    src?: string;
    width?: number;
    height?: number;
  };
}

const require = createRequire(import.meta.url);

let regularFont: Buffer | undefined;
let boldFont: Buffer | undefined;
let wasmReady: Promise<void> | undefined;

function readFont(filename: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./assets/${filename}`, import.meta.url)));
}

function fonts(): { regular: Buffer; bold: Buffer } {
  regularFont ??= readFont('Inter-Regular.ttf');
  boldFont ??= readFont('Inter-Bold.ttf');
  return { regular: regularFont, bold: boldFont };
}

/**
 * Loads `@resvg/resvg-wasm`'s `index_bg.wasm` once. A second `initWasm` call throws, so the
 * in-flight promise is reused. A failed init is forgotten so the next rank card can try again.
 * Satori's default build embeds its own layout wasm; this cache is only for resvg.
 */
export function ensureRankCardWasm(): Promise<void> {
  wasmReady ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch(
    (err: unknown) => {
      wasmReady = undefined;
      throw err;
    },
  );
  return wasmReady;
}

function finiteCount(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function formatCount(value: number): string {
  return finiteCount(value).toLocaleString('en-US');
}

/** Collapses whitespace and caps the length so a pasted novel cannot blow the layout. */
export function normalizeDisplayName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  const base = flat.length > 0 ? flat : 'Member';
  const chars = Array.from(base);
  if (chars.length <= 48) return base;
  return `${chars.slice(0, 47).join('')}…`;
}

function initialOf(name: string): string {
  const first = Array.from(name)[0];
  if (!first) return '?';
  return first.toLocaleUpperCase('en-US');
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function avatarSrc(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.byteLength < 8) return null;
  const mime = imageMime(bytes);
  if (!mime) return null;
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Characters Inter does not cover (CJK, emoji, most symbols above U+2FFF) become a retry name. */
function interSafeName(name: string): string {
  const kept = Array.from(name)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code < 0x3000 && code !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return kept.length > 0 ? kept : 'Member';
}

/** Numbers and labels for the card. No I/O. */
export function buildRankCardModel(input: RankCardInput): RankCardModel {
  const xp = finiteCount(input.xp);
  const { level, intoLevel, span } = levelProgress(xp);
  const progress = span > 0 ? Math.min(1, Math.max(0, intoLevel / span)) : 0;
  const displayName = normalizeDisplayName(input.displayName);
  return {
    displayName,
    rankLabel: `#${formatCount(Math.max(1, finiteCount(input.rank, 1)))}`,
    levelLabel: formatCount(level),
    progressLabel: `${formatCount(intoLevel)} / ${formatCount(span)} XP`,
    totalLabel: `${formatCount(xp)} XP total`,
    progress,
    avatarSrc: avatarSrc(input.avatar),
    initial: initialOf(displayName),
  };
}

function node(
  type: string,
  style: Record<string, string | number>,
  children?: CardNode | CardNode[] | string,
  extra?: { src?: string; width?: number; height?: number },
): CardNode {
  return { type, props: { style, children, ...extra } };
}

function avatarNode(model: RankCardModel): CardNode {
  if (model.avatarSrc) {
    return node('img', { borderRadius: AVATAR_SIZE / 2 }, undefined, {
      src: model.avatarSrc,
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
    });
  }
  return node(
    'div',
    {
      display: 'flex',
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
      backgroundColor: COLOR.accent,
      color: COLOR.placeholder,
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 56,
      fontWeight: 700,
    },
    model.initial,
  );
}

function statBlock(label: string, value: string): CardNode {
  return node('div', { display: 'flex', flexDirection: 'column', marginRight: 48 }, [
    node('div', { display: 'flex', fontSize: 14, color: COLOR.muted, letterSpacing: 1.2 }, label),
    node('div', { display: 'flex', fontSize: 32, fontWeight: 700, color: COLOR.text, marginTop: 2 }, value),
  ]);
}

function progressBar(progress: number): CardNode {
  const fill = Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10;
  const rest = Math.round((100 - fill) * 10) / 10;
  const parts: CardNode[] = [];
  if (fill > 0) {
    parts.push(
      node('div', { display: 'flex', width: `${fill}%`, height: 14, backgroundColor: COLOR.accent }),
    );
  }
  if (rest > 0) {
    parts.push(node('div', { display: 'flex', width: `${rest}%`, height: 14 }));
  }
  return node(
    'div',
    {
      display: 'flex',
      width: TEXT_WIDTH,
      height: 14,
      borderRadius: 7,
      backgroundColor: COLOR.track,
      overflow: 'hidden',
      marginTop: 22,
    },
    parts,
  );
}

/** The satori tree for one card. */
export function rankCardElement(model: RankCardModel): CardNode {
  return node(
    'div',
    {
      display: 'flex',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      backgroundColor: COLOR.background,
      color: COLOR.text,
      fontFamily: 'Inter',
      fontSize: 18,
    },
    [
      node('div', { display: 'flex', width: 8, height: CARD_HEIGHT, backgroundColor: COLOR.accent }),
      node(
        'div',
        {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: CARD_WIDTH - 8,
          height: CARD_HEIGHT,
          paddingLeft: 32,
          paddingRight: 32,
        },
        [
          avatarNode(model),
          node(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              width: TEXT_WIDTH,
              marginLeft: 28,
            },
            [
              node(
                'div',
                {
                  display: 'flex',
                  fontSize: 34,
                  fontWeight: 700,
                  color: COLOR.text,
                  width: TEXT_WIDTH,
                  overflow: 'hidden',
                },
                model.displayName,
              ),
              node('div', { display: 'flex', flexDirection: 'row', marginTop: 14 }, [
                statBlock('RANK', model.rankLabel),
                statBlock('LEVEL', model.levelLabel),
              ]),
              progressBar(model.progress),
              node(
                'div',
                {
                  display: 'flex',
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  width: TEXT_WIDTH,
                  marginTop: 10,
                  fontSize: 16,
                  color: COLOR.muted,
                },
                [
                  node('div', { display: 'flex' }, model.progressLabel),
                  node('div', { display: 'flex' }, model.totalLabel),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

function satoriOptions(): {
  width: number;
  height: number;
  fonts: { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[];
  embedFont: boolean;
} {
  const { regular, bold } = fonts();
  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    embedFont: true,
    fonts: [
      { name: 'Inter', data: Buffer.from(regular), weight: 400, style: 'normal' },
      { name: 'Inter', data: Buffer.from(bold), weight: 700, style: 'normal' },
    ],
  };
}

// Satori's published type is React's `ReactNode`. The object tree above is the documented non-JSX
// input, and this package does not depend on React, so the call site casts.
async function renderSvg(model: RankCardModel): Promise<string> {
  try {
    return await satori(rankCardElement(model) as never, satoriOptions());
  } catch (err) {
    const displayName = interSafeName(model.displayName);
    if (displayName === model.displayName && !model.avatarSrc) throw err;
    const retry: RankCardModel = {
      ...model,
      displayName,
      avatarSrc: null,
      initial: initialOf(displayName),
    };
    return satori(rankCardElement(retry) as never, satoriOptions());
  }
}

async function svgToPng(svg: string): Promise<Buffer> {
  await ensureRankCardWasm();
  const { regular, bold } = fonts();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    background: COLOR.background,
    font: {
      fontBuffers: [Buffer.from(regular), Buffer.from(bold)],
      defaultFontFamily: 'Inter',
      loadSystemFonts: false,
    },
  });
  const rendered = resvg.render();
  try {
    return Buffer.from(rendered.asPng());
  } finally {
    rendered.free();
    resvg.free();
  }
}

/** Renders a rank card PNG. Throws if the wasm, the fonts, or both layout attempts fail. */
export async function renderRankCard(input: RankCardInput): Promise<Buffer> {
  const model = buildRankCardModel(input);
  const svg = await renderSvg(model);
  return svgToPng(svg);
}
