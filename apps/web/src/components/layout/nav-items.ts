export interface NavItem {
  href: string;
  label: string;
  icon: string; // emoji-заглушка, потом заменим
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Главная', icon: '📊' },
  { href: '/transactions', label: 'Операции', icon: '💸' },
  { href: '/accounts', label: 'Счета', icon: '🏦' },
  { href: '/categories', label: 'Категории', icon: '🏷️' },
  { href: '/counterparties', label: 'Контрагенты', icon: '👥' },
];
