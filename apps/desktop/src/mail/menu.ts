/**
 * The look of the small menus in Mail (a recipient, a mailbox, one mail): compact rows,
 * small text and small icons, so a menu reads as a quiet list and not as a panel.
 * Written out in full: the class names have to be found as they are by the style build.
 */
export const MENU =
  "min-w-40 p-1 [&_[data-slot=dropdown-menu-item]]:gap-2 [&_[data-slot=dropdown-menu-item]]:rounded-md [&_[data-slot=dropdown-menu-item]]:px-2 [&_[data-slot=dropdown-menu-item]]:py-1 [&_[data-slot=dropdown-menu-item]]:text-xs [&_[data-slot=dropdown-menu-item]_svg]:size-3.5! [&_[data-slot=dropdown-menu-separator]]:my-1";
