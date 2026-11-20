const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const minimumWidth = 120;
const maximumSize = 10_000;

export function stickyBounds(paper, reader) {
  const left = Math.max(0, Math.ceil(reader.left - paper.left + 4));
  const top = Math.max(0, Math.ceil(reader.top - paper.top + 4));
  const right = Math.min(Math.floor(paper.width), Math.floor(reader.right - paper.left - 4));
  const bottom = Math.min(Math.floor(paper.height), Math.floor(reader.bottom - paper.top - 4));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

export function placeStickyBox(x, y, bounds, preferred, measureHeight) {
  const maxWidth = Math.min(maximumSize, bounds.right - bounds.left);
  const maxHeight = Math.min(maximumSize, bounds.bottom - bounds.top);
  const width = clamp(preferred?.width ?? 202, Math.min(minimumWidth, maxWidth), maxWidth);
  const height = Math.min(maxHeight, Math.max(preferred?.height ?? 108, measureHeight(width)));
  const place = (pin, min, max, size, offset) => {
    const edge = max - size;
    const start = offset != null ? pin + offset : pin + 10 <= edge ? pin + 10 : pin - 10 - size;
    return clamp(Math.round(start), min, edge);
  };
  return {
    left: place(x, bounds.left, bounds.right, width, preferred?.offsetX),
    top: place(y, bounds.top, bounds.bottom, height, preferred?.offsetY),
    width, height,
  };
}

export function resizeStickyBox(start, bounds, edge, dx, dy, measureHeight) {
  const west = edge.includes('w'), east = edge.includes('e');
  const north = edge.includes('n'), south = edge.includes('s');
  const right = start.left + start.width, bottom = start.top + start.height;
  const maxHeight = Math.min(maximumSize, north ? bottom - bounds.top
    : south ? bounds.bottom - start.top : bounds.bottom - bounds.top);
  let width = start.width;
  if (west || east) {
    const maxWidth = Math.min(maximumSize, west ? right - bounds.left : bounds.right - start.left);
    width = clamp(start.width + (west ? -dx : dx), Math.min(maxWidth, minimumWidth), maxWidth);
    if (width < start.width && measureHeight(width) > maxHeight) {
      // Find the closest width that fits before reaching the dragged position.
      let low = width, high = start.width;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (measureHeight(middle) > maxHeight) low = middle + 1;
        else high = middle;
      }
      width = low;
    }
  }
  const requestedHeight = start.height + (north ? -dy : south ? dy : 0);
  const height = Math.min(maxHeight, Math.max(requestedHeight, measureHeight(width)));
  return {
    left: west ? right - width : start.left,
    top: north ? bottom - height : south ? start.top : Math.min(start.top, bounds.bottom - height),
    width, height,
  };
}
