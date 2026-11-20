import type { BoardLayout } from '../drivers/types';

/** A small drawing of the board for the device card. */
export function BoardThumb({ layout }: { layout: BoardLayout }) {
  const w = Math.max(layout.width, 1);
  const h = Math.max(layout.height, 1);
  return (
    <svg className="drv-thumb" viewBox={`-0.3 -0.3 ${w + 0.6} ${h + 0.6}`} aria-hidden="true">
      <rect
        x={-0.3}
        y={-0.3}
        width={w + 0.6}
        height={h + 0.6}
        rx={0.45}
        className="drv-thumb-case"
      />
      {layout.keys.map(k => (
        <rect
          key={k.index}
          x={k.x + 0.08}
          y={k.y + 0.08}
          width={Math.max(0.1, k.w - 0.16)}
          height={Math.max(0.1, k.h - 0.16)}
          rx={0.14}
          className="drv-thumb-key"
        />
      ))}
    </svg>
  );
}
