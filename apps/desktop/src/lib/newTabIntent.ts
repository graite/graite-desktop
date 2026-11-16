/** Whether the click that is being handled asks for a new tab: Ctrl/Cmd+click or a middle
 * click. Recorded at the window, so every way of opening a page honours it without each
 * opener passing the mouse event along. */
let asked = 0;

const WINDOW_MS = 1500; // long enough for a link that resolves its target first

function note(event: MouseEvent) {
  const wants = event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0);
  asked = wants ? Date.now() : 0;
}

export function watchNewTabIntent(): () => void {
  window.addEventListener("click", note, true);
  window.addEventListener("auxclick", note, true);
  return () => {
    window.removeEventListener("click", note, true);
    window.removeEventListener("auxclick", note, true);
  };
}

/** True once per qualifying click. */
export function takeNewTabIntent(): boolean {
  const wants = asked > 0 && Date.now() - asked < WINDOW_MS;
  asked = 0;
  return wants;
}
