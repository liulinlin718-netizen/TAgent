'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import type { WorkflowEvent } from './WorkflowDrawer.logic';
import styles from './WorkflowDrawer.module.css';

export type WorkflowScrollPositions = Map<string, { offset: number; measurements?: VirtualItem[] }>;

export function WorkflowEventList({ events, label, className, renderEvent, offsets, listId }: {
  events: WorkflowEvent[];
  label: string;
  className: string;
  renderEvent: (event: WorkflowEvent) => ReactNode;
  offsets: WorkflowScrollPositions;
  listId: string;
}) {
  const scrollElement = useRef<HTMLDivElement>(null);
  const virtual = events.length > 80;
  const [initial] = useState(() => offsets.get(listId));
  const getItemKey = useCallback((index: number) => events[index].eventId, [events]);
  // TanStack owns mutable measurements; this component must not be compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const list = useVirtualizer({
    count: events.length, enabled: virtual, getItemKey,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => 180, overscan: 5, gap: 10,
    initialOffset: initial?.offset || 0,
    initialMeasurementsCache: initial?.measurements,
  });

  useLayoutEffect(() => {
    const element = scrollElement.current;
    if (!element) return;
    if (!virtual) element.scrollTop = initial?.offset || 0;
    // Restoring only pixels would jump when previously measured rows become estimates.
    return () => { offsets.set(listId, { offset: element.scrollTop, measurements: virtual ? list.takeSnapshot() : undefined }); };
  }, [listId, offsets, virtual, list, initial]);

  return <div ref={scrollElement} className={`${className} ${virtual ? styles.virtualScroll : ''}`}
    role="list" tabIndex={0} aria-label={label} data-event-count={events.length}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (virtual) list.scrollToIndex(event.key === 'Home' ? 0 : events.length - 1, { align: event.key === 'Home' ? 'start' : 'end' });
      else event.currentTarget.scrollTop = event.key === 'Home' ? 0 : event.currentTarget.scrollHeight;
    }}>
    {virtual ? <div className={styles.virtualSpacer} style={{ height: list.getTotalSize() }}>
      {list.getVirtualItems().map(item => <div key={item.key} ref={list.measureElement} data-index={item.index}
        role="listitem" aria-posinset={item.index + 1} aria-setsize={events.length}
        className={styles.virtualRow} style={{ transform: `translateY(${item.start}px)` }}>
        {renderEvent(events[item.index])}
      </div>)}
    </div> : events.map((event, index) => <div key={event.eventId} role="listitem" aria-posinset={index + 1}
      aria-setsize={events.length}>{renderEvent(event)}</div>)}
  </div>;
}
