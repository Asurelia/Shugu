/**
 * ScrollBox — scrollable container with sticky-scroll support.
 *
 * Simplified version of Claude Code's ScrollBox.
 * When stickyScroll is true, new content auto-scrolls to bottom.
 */

import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Box, type DOMElement } from 'ink';

export interface ScrollBoxHandle {
  scrollToBottom: () => void;
}

interface Props {
  children: React.ReactNode;
  stickyScroll?: boolean;
}

/**
 * A Box that contains scrollable content.
 * Ink handles overflow natively with overflow="hidden".
 * We just ensure the content is always visible by managing scroll state.
 *
 * Note: Ink doesn't have native scroll. We simulate it by only rendering
 * the last N children that fit the viewport. The parent controls this.
 */
export const ScrollBox = forwardRef<ScrollBoxHandle, Props>(function ScrollBox(
  { children, stickyScroll = true },
  ref,
) {
  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      // In our simplified version, sticky scroll is always on
      // The parent renders only the last N items
    },
  }));

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {children}
    </Box>
  );
});
