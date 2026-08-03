let deferredKey: string | null = null;

function disabled(element: HTMLElement): boolean {
  return (element as HTMLInputElement).disabled === true;
}

export function replaceChildrenPreservingFocus(container: HTMLElement, host: HTMLElement): void {
  const view = container.ownerDocument.defaultView;
  const active = container.contains(container.ownerDocument.activeElement)
    ? (container.ownerDocument.activeElement as HTMLElement)
    : null;
  const key = active?.dataset.focusKey ?? deferredKey ?? undefined;
  const textControl = Boolean(
    view && active && (active instanceof view.HTMLInputElement || active instanceof view.HTMLTextAreaElement),
  );
  const selection = textControl
    ? {
        start: (active as HTMLInputElement).selectionStart,
        end: (active as HTMLInputElement).selectionEnd,
        direction: (active as HTMLInputElement).selectionDirection,
      }
    : null;
  container.replaceChildren(host);
  if (!key) return;
  const next = [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (element) => element.dataset.focusKey === key,
  );
  if (!next) {
    deferredKey = null;
    return;
  }
  if (disabled(next)) {
    deferredKey = key;
    return;
  }
  deferredKey = null;
  next.focus();
  if (
    view &&
    selection &&
    (next instanceof view.HTMLInputElement || next instanceof view.HTMLTextAreaElement) &&
    selection.start !== null &&
    selection.end !== null
  ) {
    next.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  }
}
