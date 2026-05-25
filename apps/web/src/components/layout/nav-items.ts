import {
  Home,
  Receipt,
  Repeat,
  Upload,
  Wallet,
  Tag,
  Users,
  BarChart3,
  Filter,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Главная', icon: Home }],
  },
  {
    label: 'Учёт',
    items: [
      { href: '/transactions', label: 'Операции', icon: Receipt },
      { href: '/recurring', label: 'Регулярные', icon: Repeat },
      { href: '/import', label: 'Импорт', icon: Upload },
    ],
  },
  {
    label: 'Справочники',
    items: [
      { href: '/accounts', label: 'Счета', icon: Wallet },
      { href: '/categories', label: 'Категории', icon: Tag },
      { href: '/counterparties', label: 'Контрагенты', icon: Users },
    ],
  },
  {
    label: 'Аналитика',
    items: [
      { href: '/reports', label: 'Отчёты', icon: BarChart3 },
      { href: '/reports/rules', label: 'Правила', icon: Filter },
    ],
  },
];

/** Flat list for breadcrumb-label lookups by exact href. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
