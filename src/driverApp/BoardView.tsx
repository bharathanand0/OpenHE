import type { ReactNode } from 'react';
import type { BoardLayout } from '../drivers/types';

/**
 * The board's own layout, drawn from the driver. Each key shows whatever the
 * page passes in `render`; `fill` (0..1) draws a bar from the bottom.
 */
export function BoardView({
  layout,
  selected,
  onKeyClick,
  render,
  fill
}: {
  layout: BoardLayout;
  selected?: ReadonlySet<number>;
  onKeyClick?: (index: number, event: React.MouseEvent) => void;
  render: (index: number) => ReactNode;
  fill?: (index: number) => number | null;
}) {
  const unit = 100 / Math.max(layout.width, 1);
  return (
    <div
      className="drv-board"
      style={{ aspectRatio: `${layout.width} / ${Math.max(layout.height, 1)}` }}
    >
      {layout.keys.map(key => {
        const f = fill?.(key.index) ?? null;
        return (
          <button
            type="button"
            key={key.index}
            className={`drv-key${selected?.has(key.index) ? ' is-selected' : ''}`}
            style={{
              left: `${key.x * unit}%`,
              top: `${(key.y / Math.max(layout.height, 1)) * 100}%`,
              width: `${key.w * unit}%`,
              height: `${(key.h / Math.max(layout.height, 1)) * 100}%`
            }}
            onClick={event => onKeyClick?.(key.index, event)}
            title={key.label}
          >
            {f !== null && f > 0.005 && (
              <span
                className="drv-key-fill"
                style={{ height: `${Math.min(1, Math.max(0, f)) * 100}%` }}
              />
            )}
            <span className="drv-key-cap">{render(key.index)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Click selects one key, Shift/Ctrl/Cmd-click toggles. */
export function nextSelection(
  prev: ReadonlySet<number>,
  index: number,
  event: React.MouseEvent
): Set<number> {
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    const next = new Set(prev);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  }
  return prev.size === 1 && prev.has(index) ? new Set() : new Set([index]);
}
